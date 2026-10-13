// ─────────────────────────────────────────────────────────────────────────────
// Room actor. Single source of truth for one watch party. Node's event loop
// processes one message at a time, so every command is applied atomically and
// in arrival order — concurrency is solved by construction. Every state change
// is broadcast as a sequenced, idempotent event (kept in a ring for resume).
// ─────────────────────────────────────────────────────────────────────────────
import type {
  ChaosMsg,
  ClientMsg,
  CmdMsg,
  HelloMsg,
  MediaInput,
  PickMsg,
  PlaylistMsg,
  PointerMsg,
  PollClientMsg,
  ReportMsg,
  RoomEvent,
  RtcData,
  ServerMsg,
} from '../shared/protocol';
import { expectedPosition } from '../shared/sync';
import {
  HEAT_BIN_SECONDS,
  type ChaosConfig,
  type ChatMessage,
  type ControlVote,
  type ControlVoteKind,
  type Media,
  type MediaStats,
  type Member,
  type Movie,
  type PickSession,
  type PlaybackCause,
  type PlaybackState,
  type PlaylistItem,
  type Poll,
  type PublicSettings,
  type RoomSnapshot,
  type UpNext,
} from '../shared/types';
import { fmtTime, uid } from '../shared/util';
import type { Catalog } from './catalog/catalog';
import type { Taste } from './catalog/recommend';
import { Bucket, serverNow } from './clock';
import { Metrics } from './metrics';

export const GRACE_MS = 30_000; // keep a disconnected member's seat this long
export const HOST_GRACE_MS = 15_000; // hand host over after this much host absence
export const HOLD_MAX_MS = 10_000; // strict mode: max time we wait for a buffering member
export const BUFFER_TRIGGER_MS = 1_200; // buffering longer than this triggers a hold
export const AUTOSTART_MAX_WAIT_MS = 8_000;
export const LATE_JOIN_GRACE_MS = 10_000; // a member catching up after (re)joining never pauses the room
export const EVENT_LOG = 600;

export interface Conn {
  send(data: string): void;
  close(code: number, reason: string): void;
  chaos: ChaosConfig | null;
}

export interface RoomSettings {
  name: string;
  controlMode: 'host' | 'everyone' | 'democracy';
  syncPolicy: 'strict' | 'relaxed';
  autoplayNext: boolean;
  passcode: string | null;
}

interface MemberRec extends Member {
  token: string;
  conn: Conn | null;
  telemetry: { drift: number | null; rtt: number | null; offset: number | null; rate: number | null };
  bufferingSince: number | null;
  releasedUntil: number;
  offlineSince: number | null;
  /** Last time this member was (re)loading media — catch-up buffering right after never holds the room. */
  loadingAt: number;
  chaos: ChaosConfig | null;
  buckets: MemberBuckets;
  lastTypingAt: number;
}

interface MemberBuckets {
  chat: Bucket;
  react: Bucket;
  cmd: Bucket;
  pointer: Bucket;
  hover: Bucket;
  rtc: Bucket;
}

const newBuckets = (): MemberBuckets => ({
  chat: new Bucket(1.5, 6),
  react: new Bucket(8, 16),
  cmd: new Bucket(6, 12),
  pointer: new Bucket(40, 80),
  hover: new Bucket(12, 24),
  rtc: new Bucket(60, 240),
});

/** Wait this long after a film ends before auto-playing the next — time for the Wrap & ratings. */
export const UP_NEXT_DELAY_MS = 25_000;
export const SPEEDS = [0.75, 1, 1.25, 1.5] as const;

export type JoinResult = { ok: true; member: MemberRec } | { ok: false; code: string; message: string };

export interface RoomDeps {
  catalog: Catalog;
  chaosEnabled: boolean;
  cap: number;
}

const EMPTY_PLAYBACK = (): PlaybackState => ({
  media: null,
  status: 'paused',
  position: 0,
  at: serverNow(),
  rate: 1,
  version: 0,
  by: null,
  byName: null,
  cause: 'init',
  cmdId: null,
  issuedAt: null,
  concurrentWith: null,
  hold: null,
  ended: false,
});

export class Room {
  readonly metrics = new Metrics();
  createdAt = Date.now();
  members = new Map<string, MemberRec>();
  playback: PlaybackState = EMPTY_PLAYBACK();
  playlist: PlaylistItem[] = [];
  currentItemId: string | null = null;
  chat: ChatMessage[] = [];
  polls: Poll[] = [];
  votes: ControlVote[] = [];
  pick: PickSession | null = null;
  upNext: UpNext | null = null;
  heatmap: Record<string, number[]> = {};
  /** One entry per film watched here (Wrap, ratings, catch-up). Most recent last. */
  stats: MediaStats[] = [];
  taste = new Map<string, { name: string; likes: Set<string>; dislikes: Set<string> }>();
  banned = new Set<string>();
  emptySince: number | null = Date.now();
  dirty = true;

  private seq = 0;
  private log: { seq: number; ev: RoomEvent }[] = [];
  private lastChangeAt = serverNow();
  private cmdInfo = new Map<number, { issuedAt: number; by: string; kind: string }>();
  private pendingStart: { since: number } | null = null;
  private pollVotes = new Map<string, Map<string, string[]>>();
  private pickSwipes = new Map<string, Map<string, boolean>>();
  private seenChat = new Set<string>();
  private reactionBatch: { memberId: string; emoji: string; mediaTime: number | null }[] = [];
  private heatDirty = false;
  private statsDirty = false;
  private lastTickAt = serverNow();
  private verdictPosted = new Set<string>();
  private ticks = 0;
  private lastPlaybackNote = { by: '', kind: '', at: 0 };

  constructor(
    readonly code: string,
    public settings: RoomSettings,
    private readonly deps: RoomDeps,
  ) {}

  // ─── Connection lifecycle ──────────────────────────────────────────────────

  join(hello: HelloMsg, conn: Conn): JoinResult {
    const t = serverNow();
    if (hello.token && this.banned.has(hello.token)) return { ok: false, code: 'kicked', message: 'You were removed from this room by the host.' };
    const existing = hello.token ? [...this.members.values()].find((m) => m.token === hello.token) : undefined;

    if (existing) {
      // ── Resume: same identity, same seat, same role. ──
      if (existing.conn && existing.conn !== conn) existing.conn.close(4002, 'Session opened in another tab');
      existing.conn = conn;
      conn.chaos = existing.chaos;
      existing.online = true;
      existing.offlineSince = null;
      existing.loadingAt = t;
      existing.name = hello.name;
      existing.avatar = hello.avatar;
      existing.color = hello.color;
      this.emptySince = null;
      const first = this.log[0]?.seq ?? this.seq + 1;
      const canReplay = hello.lastSeq != null && hello.lastSeq >= first - 1 && hello.lastSeq <= this.seq;
      if (canReplay) {
        const missed = this.log.filter((x) => x.seq > hello.lastSeq!);
        this.send(existing, { t: 'resumed', replayed: missed.length, seq: this.seq, serverTime: t });
        for (const x of missed) existing.conn!.send(JSON.stringify({ t: 'ev', seq: x.seq, ev: x.ev } satisfies ServerMsg));
        const cur = this.stats.at(-1);
        if (cur) this.send(existing, { t: 'stats', stats: cur }); // stats are ephemeral — refresh on resume
      } else {
        this.welcome(existing, true);
      }
      this.emit({ e: 'member', member: this.pub(existing) });
      return { ok: true, member: existing };
    }

    if (this.settings.passcode && hello.passcode !== this.settings.passcode)
      return { ok: false, code: 'passcode', message: hello.passcode ? 'Wrong passcode.' : 'This room needs a passcode.' };
    const online = [...this.members.values()].filter((m) => m.online).length;
    if (online >= this.deps.cap) return { ok: false, code: 'full', message: `Room is full (${this.deps.cap} people).` };

    const hasHost = [...this.members.values()].some((m) => m.role === 'host');
    const seats = new Set([...this.members.values()].map((m) => m.seat));
    let seat = 0;
    while (seats.has(seat)) seat++;
    const m: MemberRec = {
      id: uid(10),
      token: uid(24),
      name: hello.name,
      avatar: hello.avatar,
      color: hello.color,
      role: hasHost ? 'member' : 'host',
      online: true,
      joinedAt: t,
      seat,
      player: 'loading',
      away: false,
      browsing: null,
      device: hello.device,
      localFingerprint: null,
      voice: 'off',
      conn: null,
      telemetry: { drift: null, rtt: null, offset: null, rate: null },
      bufferingSince: null,
      releasedUntil: 0,
      offlineSince: null,
      loadingAt: t,
      chaos: null,
      buckets: newBuckets(),
      lastTypingAt: 0,
    };
    this.members.set(m.id, m);
    this.emptySince = null;
    this.emit({ e: 'member', member: this.pub(m) });
    this.system(`${m.avatar} ${m.name} joined${m.role === 'host' ? ' and is hosting' : ''}`);
    m.conn = conn;
    this.welcome(m, false);
    return { ok: true, member: m };
  }

  private welcome(m: MemberRec, resumed: boolean) {
    this.send(m, {
      t: 'welcome',
      you: m.id,
      token: m.token,
      snapshot: this.snapshot(),
      seq: this.seq,
      serverTime: serverNow(),
      resumed,
      chaosEnabled: this.deps.chaosEnabled,
    });
    if (this.pick && this.pickSwipes.has(m.id)) this.send(m, { t: 'myPick', swipes: Object.fromEntries(this.pickSwipes.get(m.id)!) });
  }

  /** Socket closed. Keep the seat for GRACE_MS so a reconnect resumes seamlessly. */
  detach(m: MemberRec, conn: Conn, explicit: boolean) {
    if (m.conn !== conn) return; // a newer connection already replaced this one
    m.conn = null;
    if (explicit) return this.removeMember(m, 'left');
    m.online = false;
    m.offlineSince = serverNow();
    m.bufferingSince = null;
    m.browsing = null;
    // Peers tear down their audio links to us; the client re-joins voice after it reconnects.
    m.voice = 'off';
    this.emit({ e: 'member', member: this.pub(m) });
    if (![...this.members.values()].some((x) => x.online)) this.emptySince = Date.now();
  }

  private removeMember(m: MemberRec, why: 'left' | 'timeout' | 'kicked') {
    if (!this.members.has(m.id)) return;
    this.members.delete(m.id);
    this.emit({ e: 'memberLeft', id: m.id, name: m.name });
    const verb = why === 'kicked' ? 'was removed' : why === 'timeout' ? 'lost connection' : 'left';
    this.system(`${m.avatar} ${m.name} ${verb}`);
    if (m.role === 'host') this.electHost(m);
    if (![...this.members.values()].some((x) => x.online)) this.emptySince = Date.now();
    if (this.pick?.status === 'active') this.checkPickProgress();
  }

  /** Successor: an online co-host, else the longest-present online member. */
  private electHost(prev: MemberRec) {
    const online = [...this.members.values()].filter((x) => x.online && x.id !== prev.id).sort((a, b) => a.joinedAt - b.joinedAt);
    const next = online.find((x) => x.role === 'cohost') ?? online[0];
    if (!next) return;
    if (this.members.has(prev.id)) {
      prev.role = 'cohost';
      this.emit({ e: 'member', member: this.pub(prev) });
    }
    next.role = 'host';
    this.emit({ e: 'member', member: this.pub(next) });
    this.system(`👑 ${next.name} is now the host`);
    this.emit({ e: 'toast', text: `${next.name} is now the host`, tone: 'info', icon: '👑' });
  }

  // ─── Dispatch ──────────────────────────────────────────────────────────────

  handle(m: MemberRec, msg: Exclude<ClientMsg, { t: 'hello' } | { t: 'ping' }>) {
    switch (msg.t) {
      case 'cmd':
        return this.onCmd(m, msg);
      case 'countdown':
        return this.onCountdown(m, msg.seconds);
      case 'ack':
        return this.onAck(m, msg);
      case 'report':
        return this.onReport(m, msg);
      case 'ended':
        return this.onEnded(msg.mediaId);
      case 'chat':
        return this.onChat(m, msg);
      case 'chatReact':
        return this.onChatReact(m, msg.msgId, msg.emoji);
      case 'typing':
        return this.onTyping(m);
      case 'react':
        return this.onReact(m, msg.emoji, msg.mediaTime);
      case 'pl':
        return this.onPlaylist(m, msg);
      case 'poll':
        return this.onPoll(m, msg);
      case 'vote':
        return this.castVote(m, msg.voteId, msg.yes);
      case 'role':
        return this.onRole(m, msg.op, msg.target);
      case 'settings':
        return this.onSettings(m, msg.patch);
      case 'pick':
        return this.onPick(m, msg);
      case 'browse':
        if (m.browsing !== msg.movieId) {
          m.browsing = msg.movieId;
          this.emit({ e: 'member', member: this.pub(m) });
        }
        return;
      case 'suggest':
        return this.onSuggest(m, msg.movieId);
      case 'profile':
        m.name = msg.name;
        m.avatar = msg.avatar;
        m.color = msg.color;
        return this.emit({ e: 'member', member: this.pub(m) });
      case 'chaos':
        return this.onChaos(m, msg);
      case 'speed':
        return this.onSpeed(m, msg.rate);
      case 'hover':
        if (m.buckets.hover.take()) this.relay(m, { t: 'hover', memberId: m.id, time: msg.time });
        return;
      case 'pointer':
        return this.onPointer(m, msg);
      case 'rating':
        return this.onRating(m, msg.mediaId, msg.stars);
      case 'voice': {
        const next = msg.on ? (msg.mic ? 'talk' : 'listen') : 'off';
        if (m.voice === next) return;
        const joined = m.voice === 'off' && next !== 'off';
        m.voice = next;
        this.emit({ e: 'member', member: this.pub(m) });
        if (joined) this.system(`🎙 ${m.name} joined voice${next === 'listen' ? ' (listening)' : ''}`);
        return;
      }
      case 'rtc':
        return this.onRtc(m, msg.to, msg.data);
      case 'speaking':
        if (m.voice === 'talk') this.relay(m, { t: 'speaking', memberId: m.id, on: msg.on });
        return;
      case 'leave':
        if (m.conn) {
          const c = m.conn;
          this.detach(m, c, true);
          c.close(1000, 'left');
        }
        return;
    }
  }

  // ─── Playback ──────────────────────────────────────────────────────────────

  canControl(m: MemberRec): boolean {
    return this.settings.controlMode === 'everyone' || m.role !== 'member';
  }

  private onCmd(m: MemberRec, cmd: CmdMsg) {
    const reply = (ok: boolean, extra: { noop?: boolean; reason?: string } = {}) =>
      this.send(m, { t: 'cmdResult', cmdId: cmd.cmdId, ok, version: this.playback.version, ...extra });
    if (!m.buckets.cmd.take()) return reply(false, { reason: 'Too many commands — slow down' });
    if (!this.playback.media) return reply(false, { reason: 'Nothing is loaded yet' });
    if (!this.canControl(m)) {
      if (this.settings.controlMode === 'democracy') {
        this.openVote(m, cmd.kind, cmd.position);
        return reply(false, { reason: 'vote' });
      }
      return reply(false, { reason: 'Only the host can control playback' });
    }
    const r = this.applyPlayback(cmd.kind, cmd.position, m, {
      cmdId: cmd.cmdId,
      issuedAt: cmd.issuedAt,
      baseVersion: cmd.baseVersion,
    });
    reply(true, r);
  }

  /**
   * Core transition. The anchor is placed at the initiator's *click* time
   * (clamped), not at arrival time — the initiator applied optimistically at
   * click, so it is already in sync, and receivers compensate transit through
   * expectedPosition().
   */
  private applyPlayback(
    kind: 'play' | 'pause' | 'seek',
    position: number,
    actor: MemberRec | null,
    o: { cmdId?: string; issuedAt?: number; baseVersion?: number; cause?: PlaybackCause } = {},
  ): { noop?: boolean; reason?: string } {
    const t = serverNow();
    const p = this.playback;
    const dur = p.media?.duration ?? null;
    const rawIssued = o.issuedAt ?? t;
    const issuedAt = Math.min(t, Math.max(rawIssued, t - 1000, this.lastChangeAt));
    const concurrentWith =
      o.baseVersion != null && o.baseVersion < p.version && t - this.lastChangeAt < 1500 && p.by && p.by !== actor?.id ? p.byName : null;
    const expectedAtClick = expectedPosition(p, issuedAt, dur);
    this.pendingStart = null;
    const extra = { cmdId: o.cmdId, rawIssuedAt: o.cmdId ? rawIssued : undefined, concurrentWith };

    if (kind === 'play') {
      if (p.status === 'playing' && !p.hold) return { noop: true, reason: p.byName ? `Already playing (${p.byName})` : 'Already playing' };
      let pos = p.status === 'paused' ? p.position : expectedAtClick;
      if (p.ended || (dur && pos >= dur - 0.5)) pos = 0;
      this.setPlayback({ status: 'playing', position: pos, at: issuedAt, cause: o.cause ?? 'play' }, actor, { ...extra, issuedAt });
    } else if (kind === 'pause') {
      if (p.status === 'paused' && !p.hold && p.at <= t) return { noop: true, reason: p.byName ? `Already paused by ${p.byName}` : 'Already paused' };
      // Freeze everyone on the exact frame the initiator saw (if plausible).
      const pos = Math.abs(position - expectedAtClick) < 2 ? position : expectedAtClick;
      this.setPlayback({ status: 'paused', position: pos, at: t, cause: o.cause ?? 'pause' }, actor, { ...extra, issuedAt });
    } else {
      const pos = Math.max(0, dur ? Math.min(position, dur - 0.1) : position);
      const scheduled = p.status === 'playing' && p.at > t;
      this.setPlayback(
        { status: p.status, position: pos, at: scheduled ? p.at : issuedAt, cause: o.cause ?? 'seek', hold: p.hold },
        actor,
        { ...extra, issuedAt },
      );
    }
    if (actor) {
      this.notePlayback(actor, kind, kind === 'seek' ? position : this.playback.position);
      this.bumpStat(actor, 'commands');
    }
    if (this.upNext && kind !== 'pause') this.setUpNext(null);
    return {};
  }

  private setPlayback(
    patch: Partial<PlaybackState>,
    actor: MemberRec | null,
    extra: { cmdId?: string; issuedAt?: number; rawIssuedAt?: number; concurrentWith?: string | null } = {},
  ) {
    const t = serverNow();
    const version = this.playback.version + 1;
    this.playback = {
      ...this.playback, // rate persists across play/pause/seek; a new film resets it explicitly
      ...patch,
      hold: patch.hold ?? null,
      ended: patch.ended ?? false,
      version,
      by: actor?.id ?? null,
      byName: actor?.name ?? null,
      cmdId: extra.cmdId ?? null,
      issuedAt: extra.issuedAt ?? t,
      concurrentWith: extra.concurrentWith ?? null,
    };
    this.lastChangeAt = t;
    if (extra.cmdId && actor && extra.rawIssuedAt != null && Math.abs(t - extra.rawIssuedAt) < 5000) {
      this.cmdInfo.set(version, { issuedAt: extra.rawIssuedAt, by: actor.id, kind: this.playback.cause });
      if (this.cmdInfo.size > 64) this.cmdInfo.delete(this.cmdInfo.keys().next().value!);
    }
    this.emit({ e: 'playback', playback: this.playback });
  }

  private notePlayback(m: MemberRec, kind: string, pos: number) {
    const t = Date.now();
    // Coalesce scrubbing / rapid toggles into one activity line.
    if (this.lastPlaybackNote.by === m.id && this.lastPlaybackNote.kind === kind && t - this.lastPlaybackNote.at < 2500) return;
    this.lastPlaybackNote = { by: m.id, kind, at: t };
    const verb = kind === 'play' ? '▶ resumed' : kind === 'pause' ? '⏸ paused' : '⏩ jumped to';
    this.system(`${m.name} ${verb} ${kind === 'seek' ? fmtTime(pos) : `at ${fmtTime(pos)}`}`);
  }

  private onCountdown(m: MemberRec, seconds: number) {
    const p = this.playback;
    if (!p.media) return this.error(m, 'no-media', 'Load something first');
    if (!this.canControl(m)) {
      if (this.settings.controlMode === 'democracy') return this.openVote(m, 'play', null);
      return this.error(m, 'forbidden', 'Only the host can start playback');
    }
    const t = serverNow();
    let pos = p.status === 'paused' ? p.position : expectedPosition(p, t, p.media.duration);
    if (p.ended) pos = 0;
    this.pendingStart = null;
    this.setPlayback({ status: 'playing', position: pos, at: t + seconds * 1000, cause: 'countdown' }, m);
    this.system(`${m.name} started a ${seconds}-2-1 countdown 🎬`);
  }

  /** Synced speed: re-anchor at "now" so nobody jumps, then everyone advances at the new rate. */
  private onSpeed(m: MemberRec, rate: number) {
    const p = this.playback;
    if (!p.media) return;
    if (!this.canControl(m)) return this.error(m, 'forbidden', 'Only hosts can change the speed in this room');
    const r = SPEEDS.reduce((best, s) => (Math.abs(s - rate) < Math.abs(best - rate) ? s : best), 1);
    if (r === p.rate) return;
    const t = serverNow();
    const scheduled = p.status === 'playing' && p.at > t;
    const pos = scheduled ? p.position : expectedPosition(p, t, p.media.duration);
    this.setPlayback({ status: p.status, position: pos, at: scheduled ? p.at : t, rate: r, cause: 'seek', hold: p.hold }, m);
    this.system(r === 1 ? `🐢 ${m.name} set the speed back to normal` : `⚡ ${m.name} set the speed to ${r}× for everyone`);
  }

  /** Ephemeral fan-out to everyone except the sender (presence-style data, never replayed). */
  private relay(from: MemberRec, msg: ServerMsg) {
    const data = JSON.stringify(msg);
    for (const x of this.members.values()) if (x.conn && x.id !== from.id) x.conn.send(data);
  }

  private onPointer(m: MemberRec, p: PointerMsg) {
    if (!m.buckets.pointer.take()) return;
    this.relay(m, { t: 'pointer', memberId: m.id, x: p.x, y: p.y, mode: p.mode, end: p.end });
  }

  /** WebRTC signalling relay: offers/answers/ICE go to exactly one peer in this room. */
  private onRtc(m: MemberRec, to: string, data: RtcData) {
    const target = this.members.get(to);
    if (!target?.conn || target.id === m.id || !m.buckets.rtc.take()) return;
    if (data.type !== 'bye' && (m.voice === 'off' || target.voice === 'off')) return;
    this.send(target, { t: 'rtc', from: m.id, data });
  }

  // ─── Per-film stats (Movie Night Wrap, ratings, catch-up) ──────────────────

  private currentStats(): MediaStats | null {
    const media = this.playback.media;
    if (!media) return null;
    let s = this.stats.find((x) => x.mediaId === media.id);
    if (!s) {
      s = {
        mediaId: media.id,
        title: media.title,
        thumbnail: media.thumbnail ?? null,
        movieId: media.movieId ?? null,
        startedAt: Date.now(),
        endedAt: null,
        watchedTo: 0,
        togetherSecs: 0,
        duration: media.duration ?? null,
        moments: {},
        reactions: {},
        chat: {},
        commands: {},
        drift: {},
        ratings: {},
        people: {},
      };
      this.stats.push(s);
      if (this.stats.length > 20) this.stats.shift();
    }
    return s;
  }

  private bumpStat(m: MemberRec, field: 'chat' | 'commands') {
    const s = this.currentStats();
    if (!s) return;
    s[field][m.id] = (s[field][m.id] ?? 0) + 1;
    s.people[m.id] = { name: m.name, avatar: m.avatar, color: m.color };
    this.statsDirty = true;
  }

  private onRating(m: MemberRec, mediaId: string, stars: number) {
    const s = this.stats.find((x) => x.mediaId === mediaId);
    if (!s) return;
    s.ratings[m.id] = stars;
    s.people[m.id] = { name: m.name, avatar: m.avatar, color: m.color };
    // Ratings teach the room recommender: 4–5★ = like, 1–2★ = dislike.
    if (s.movieId && stars !== 3) this.like(m, s.movieId, stars >= 4);
    this.broadcast({ t: 'stats', stats: s });
    const online = [...this.members.values()].filter((x) => x.online);
    const rated = Object.keys(s.ratings);
    if (!this.verdictPosted.has(s.mediaId) && online.length > 0 && online.every((x) => rated.includes(x.id))) {
      this.verdictPosted.add(s.mediaId);
      const avg = Object.values(s.ratings).reduce((a, b) => a + b, 0) / rated.length;
      this.system(`⭐ Room verdict on ${s.title}: ${avg.toFixed(1)}/5 from ${rated.length} ${rated.length === 1 ? 'person' : 'people'}`);
    }
  }

  private onAck(m: MemberRec, a: { version: number; recvAt: number; appliedAt: number }) {
    const info = this.cmdInfo.get(a.version);
    if (!info || info.by === m.id) return; // the initiator applied optimistically; not a propagation sample
    const total = a.appliedAt - info.issuedAt;
    if (total < -50 || total > 10_000) return; // clock not yet synced — discard
    this.metrics.addLatency({
      kind: info.kind,
      to: m.id,
      total: Math.round(total * 10) / 10,
      delivery: Math.round((a.recvAt - info.issuedAt) * 10) / 10,
      apply: Math.round((a.appliedAt - a.recvAt) * 10) / 10,
      at: Date.now(),
    });
  }

  private onReport(m: MemberRec, r: ReportMsg) {
    const t = serverNow();
    const before = `${m.player}|${m.away}|${m.localFingerprint}`;
    m.player = r.player;
    m.away = r.away;
    if (r.localFingerprint !== undefined) m.localFingerprint = r.localFingerprint;
    m.telemetry = { drift: r.drift, rtt: r.rtt, offset: r.offset, rate: r.rate };
    if (r.player === 'loading' || r.player === 'needs-file') m.loadingAt = t;
    if (r.player === 'buffering') m.bufferingSince ??= t;
    else m.bufferingSince = null;
    const p = this.playback;
    // Steady-state drift sample: playing, settled ≥3 s since the last change, member healthy.
    if (r.drift != null && r.player === 'ready' && p.status === 'playing' && p.at < t && t - this.lastChangeAt > 3000) {
      this.metrics.addDrift(Math.abs(r.drift));
      const s = this.currentStats();
      if (s) {
        const d = (s.drift[m.id] ??= { sum: 0, n: 0 });
        d.sum += Math.abs(r.drift);
        d.n++;
        s.people[m.id] = { name: m.name, avatar: m.avatar, color: m.color };
        s.watchedTo = Math.max(s.watchedTo, expectedPosition(p, t, p.media?.duration));
      }
    }
    if (r.duration && p.media && p.media.id === r.duration.mediaId && !p.media.duration) {
      p.media.duration = r.duration.duration;
      const item = this.playlist.find((i) => i.id === p.media!.id);
      if (item) item.media.duration = r.duration.duration;
      this.emit({ e: 'playback', playback: p }); // same version: a metadata patch
    }
    if (before !== `${m.player}|${m.away}|${m.localFingerprint}`) this.emit({ e: 'member', member: this.pub(m) });
  }

  private onEnded(mediaId: string) {
    const p = this.playback;
    const t = serverNow();
    if (p.media?.id !== mediaId || p.status !== 'playing' || p.ended) return;
    const pos = expectedPosition(p, t);
    if (pos < 5) return;
    if (!p.media.duration) p.media.duration = pos;
    this.finishMedia(t);
  }

  private finishMedia(t: number) {
    const p = this.playback;
    this.setPlayback({ status: 'paused', position: p.media?.duration ?? p.position, at: t, cause: 'end', ended: true }, null);
    const s = this.currentStats();
    if (s) {
      s.endedAt = Date.now();
      s.duration = p.media?.duration ?? s.duration;
      s.watchedTo = Math.max(s.watchedTo, p.media?.duration ?? 0);
      for (const m of this.members.values()) if (m.online) s.people[m.id] = { name: m.name, avatar: m.avatar, color: m.color };
      this.broadcast({ t: 'stats', stats: s }); // clients roll the Movie Night Wrap
    }
    const next = this.nextItem();
    if (this.settings.autoplayNext && next) this.setUpNext({ itemId: next.id, at: Date.now() + UP_NEXT_DELAY_MS });
  }

  // ─── Tick: holds, auto-start, end-of-media, timers, telemetry ───────────────

  tick() {
    const t = serverNow();
    const p = this.playback;
    this.ticks++;
    const dt = Math.min(1, Math.max(0, (t - this.lastTickAt) / 1000));
    this.lastTickAt = t;
    if (p.media && p.status === 'playing' && p.at <= t && this.onlineCount > 0) {
      const s = this.currentStats();
      if (s) s.togetherSecs = (s.togetherSecs ?? 0) + dt;
    }

    if (this.reactionBatch.length) {
      this.broadcast({ t: 'reactions', items: this.reactionBatch });
      this.reactionBatch = [];
    }

    // Auto-start new media with a countdown once every viewer has it loaded.
    if (this.pendingStart && p.media && p.status === 'paused') {
      const viewers = [...this.members.values()].filter((m) => m.online && m.player !== 'detour');
      const allReady = viewers.length > 0 && viewers.every((m) => ['ready', 'error', 'blocked', 'needs-file'].includes(m.player));
      if ((allReady && t - this.pendingStart.since > 500) || t - this.pendingStart.since > AUTOSTART_MAX_WAIT_MS) {
        this.pendingStart = null;
        this.setPlayback({ status: 'playing', position: p.position, at: t + 3000, cause: 'countdown' }, null);
      }
    }

    const dur = p.media?.duration;
    if (p.status === 'playing' && dur && !p.ended && expectedPosition(p, t) >= dur - 0.25) this.finishMedia(t);

    if (this.upNext && Date.now() >= this.upNext.at) {
      const item = this.playlist.find((i) => i.id === this.upNext!.itemId);
      this.setUpNext(null);
      if (item) this.loadItem(item, null, true);
    }

    this.checkHold(t);

    for (const v of this.votes) if (!v.resolved && Date.now() > v.endsAt) this.resolveVote(v, 'failed');
    for (const poll of this.polls) if (!poll.closed && poll.endsAt && Date.now() > poll.endsAt) this.closePoll(poll, null);

    // Grace handling for disconnected members.
    for (const m of [...this.members.values()]) {
      if (m.online || m.offlineSince == null) continue;
      const away = t - m.offlineSince;
      if (m.role === 'host' && away > HOST_GRACE_MS && [...this.members.values()].some((x) => x.online)) this.electHost(m);
      if (away > GRACE_MS) this.removeMember(m, 'timeout');
    }

    if (this.ticks % 10 === 0 && [...this.members.values()].some((m) => m.online)) {
      this.broadcast({
        t: 'telemetry',
        members: [...this.members.values()].map((m) => ({ id: m.id, ...m.telemetry, chaos: m.chaos })),
        latency: this.metrics.summary(),
      });
      if (this.heatDirty && p.media) {
        this.heatDirty = false;
        this.broadcast({ t: 'heat', mediaId: p.media.id, bins: this.heatmap[p.media.id] ?? [] });
      }
    }
    // Stats are presence-like (high churn): push at most every 5 s, only when changed.
    if (this.ticks % 50 === 0 && this.statsDirty) {
      this.statsDirty = false;
      const s = this.currentStats();
      if (s) this.broadcast({ t: 'stats', stats: s });
      this.dirty = true;
    }
  }

  /** Strict policy: if someone stalls, the whole room waits (bounded), then resumes with a short countdown. */
  private checkHold(t: number) {
    const p = this.playback;
    if (p.hold) {
      const still = p.hold.waitingFor.filter((id) => {
        const x = this.members.get(id);
        return x && x.online && x.player === 'buffering' && x.releasedUntil < t;
      });
      if (!still.length) {
        this.setPlayback({ status: 'playing', position: p.position, at: t + 1500, cause: 'resume' }, null);
        this.system('▶ Everyone is ready — resuming');
      } else if (t - p.hold.since > HOLD_MAX_MS) {
        const names = still.map((id) => this.members.get(id)!.name);
        for (const id of still) this.members.get(id)!.releasedUntil = t + 60_000;
        this.setPlayback({ status: 'playing', position: p.position, at: t + 1500, cause: 'resume' }, null);
        this.system(`▶ Continuing without ${names.join(', ')} — they'll catch up automatically`);
      }
      return;
    }
    if (this.settings.syncPolicy !== 'strict' || p.status !== 'playing' || p.at > t || t - this.lastChangeAt < 2000) return;
    const stalled = [...this.members.values()].filter(
      (m) =>
        m.online &&
        m.player === 'buffering' &&
        m.bufferingSince != null &&
        t - m.bufferingSince > BUFFER_TRIGGER_MS &&
        t - m.loadingAt > LATE_JOIN_GRACE_MS &&
        m.releasedUntil < t,
    );
    if (!stalled.length) return;
    this.setPlayback(
      { status: 'paused', position: expectedPosition(p, t, p.media?.duration), at: t, cause: 'hold', hold: { waitingFor: stalled.map((m) => m.id), since: t } },
      null,
    );
    this.system(`⏳ Waiting for ${stalled.map((m) => m.name).join(', ')} to buffer…`);
  }

  // ─── Playlist ──────────────────────────────────────────────────────────────

  mediaFromMovie(movie: Movie): Media | null {
    const base = { id: uid(10), title: movie.title, thumbnail: movie.backdrop ?? movie.poster, movieId: movie.id, duration: null };
    if (movie.playable) return { ...base, kind: movie.playable.kind, url: movie.playable.url };
    if (movie.trailer) return { ...base, kind: 'youtube', youtubeId: movie.trailer, title: `${movie.title} — Trailer` };
    return null;
  }

  private mediaFromInput(input: MediaInput): Media | null {
    const id = uid(10);
    const common = { id, title: input.title.slice(0, 200), thumbnail: input.thumbnail ?? null, duration: input.duration ?? null, movieId: input.movieId ?? null };
    switch (input.kind) {
      case 'youtube':
        return input.youtubeId ? { ...common, kind: 'youtube', youtubeId: input.youtubeId, thumbnail: common.thumbnail ?? `https://i.ytimg.com/vi/${input.youtubeId}/hqdefault.jpg` } : null;
      case 'file':
      case 'hls':
        if (!input.url || !(/^https?:\/\//i.test(input.url) || input.url.startsWith('/media/'))) return null;
        return { ...common, kind: input.kind, url: input.url };
      case 'local':
        return input.local ? { ...common, kind: 'local', local: input.local, duration: input.local.duration ?? null } : null;
    }
  }

  private currentIndex(): number {
    return this.playlist.findIndex((i) => i.id === this.currentItemId);
  }

  private nextItem(): PlaylistItem | undefined {
    const i = this.currentIndex();
    return this.playlist[i + 1];
  }

  private addToPlaylist(m: MemberRec | null, media: Media, next: boolean, autoload = true): PlaylistItem | null {
    if (this.playlist.length >= 200) return null;
    const item: PlaylistItem = { id: media.id, media, addedBy: m?.id ?? 'system', addedByName: m?.name ?? 'Marquee', addedAt: Date.now() };
    if (next) this.playlist.splice(this.currentIndex() + 1, 0, item);
    else this.playlist.push(item);
    this.emit({ e: 'playlist', playlist: this.playlist });
    if (media.movieId && m) this.like(m, media.movieId);
    // First thing ever queued: load it (paused) so the room has something on screen.
    if (autoload && !this.playback.media) this.loadItem(item, null, false);
    return item;
  }

  private loadItem(item: PlaylistItem, by: MemberRec | null, autoStart: boolean) {
    const t = serverNow();
    this.currentItemId = item.id;
    this.setUpNext(null);
    this.setPlayback({ media: { ...item.media }, status: 'paused', position: 0, at: t, rate: 1, cause: 'load' }, by);
    this.currentStats(); // open tonight's lineup entry for this film
    this.statsDirty = true;
    this.pendingStart = autoStart && item.media.kind !== 'local' ? { since: t } : null;
    this.system(`🎞 Now playing: ${item.media.title}${item.media.kind === 'local' ? ' — everyone pick your copy of the file' : ''}`);
  }

  private setUpNext(u: UpNext | null) {
    if (this.upNext?.itemId === u?.itemId && this.upNext?.at === u?.at) return;
    this.upNext = u;
    this.emit({ e: 'upNext', upNext: u });
  }

  private onPlaylist(m: MemberRec, msg: PlaylistMsg) {
    const ctl = this.canControl(m);
    switch (msg.op) {
      case 'add': {
        const media = this.mediaFromInput(msg.media);
        if (!media) return this.error(m, 'bad-media', 'That link doesn’t look playable');
        const item = this.addToPlaylist(m, media, !!msg.next);
        if (item) this.system(`${m.name} queued ${media.title}`);
        return;
      }
      case 'addMovie': {
        const movie = this.deps.catalog.get(msg.movieId);
        const media = movie && this.mediaFromMovie(movie);
        if (!media) return this.error(m, 'bad-media', 'No playable version of that movie');
        const item = this.addToPlaylist(m, media, !!msg.next || !!msg.playNow, !(msg.playNow && ctl));
        if (!item) return;
        if (msg.playNow && ctl) this.loadItem(item, m, true);
        else this.system(`${m.name} queued ${media.title}`);
        return;
      }
      case 'remove': {
        const item = this.playlist.find((i) => i.id === msg.itemId);
        if (!item) return;
        if (!ctl && item.addedBy !== m.id) return this.error(m, 'forbidden', 'You can only remove your own items');
        this.playlist = this.playlist.filter((i) => i.id !== msg.itemId);
        if (this.upNext?.itemId === msg.itemId) this.setUpNext(null);
        return this.emit({ e: 'playlist', playlist: this.playlist });
      }
      case 'move': {
        if (!ctl) return this.error(m, 'forbidden', 'Only hosts can reorder the queue');
        // Anchor-relative ("after X"), never index-based → concurrent reorders can't corrupt the list.
        const from = this.playlist.findIndex((i) => i.id === msg.itemId);
        if (from < 0 || msg.afterId === msg.itemId) return;
        const [item] = this.playlist.splice(from, 1);
        const at = msg.afterId ? this.playlist.findIndex((i) => i.id === msg.afterId) + 1 : 0;
        this.playlist.splice(at < 0 ? this.playlist.length : at, 0, item);
        return this.emit({ e: 'playlist', playlist: this.playlist });
      }
      case 'play': {
        const item = this.playlist.find((i) => i.id === msg.itemId);
        if (!item) return;
        if (!ctl) return this.error(m, 'forbidden', this.settings.controlMode === 'democracy' ? 'Start a poll to pick what plays next!' : 'Only the host can switch videos');
        return this.loadItem(item, m, true);
      }
      case 'next': {
        if (!ctl) {
          if (this.settings.controlMode === 'democracy') return this.openVote(m, 'skip', null);
          return this.error(m, 'forbidden', 'Only the host can skip');
        }
        const next = this.nextItem();
        if (next) this.loadItem(next, m, true);
        return;
      }
      case 'cancelNext':
        if (ctl) this.setUpNext(null);
        return;
    }
  }

  // ─── Democracy votes ───────────────────────────────────────────────────────

  private openVote(m: MemberRec, kind: ControlVoteKind, position: number | null) {
    const active = this.votes.find((v) => !v.resolved && v.kind === kind);
    if (active) return this.castVote(m, active.id, true);
    const online = [...this.members.values()].filter((x) => x.online).length;
    const vote: ControlVote = {
      id: uid(8),
      kind,
      position,
      by: m.id,
      byName: m.name,
      yes: [m.id],
      no: [],
      needed: Math.floor(online / 2) + 1,
      endsAt: Date.now() + 15_000,
      resolved: null,
    };
    this.votes.push(vote);
    this.emit({ e: 'vote', vote });
    this.checkVote(vote);
  }

  private castVote(m: MemberRec, voteId: string, yes: boolean) {
    const v = this.votes.find((x) => x.id === voteId);
    if (!v || v.resolved) return;
    v.yes = v.yes.filter((id) => id !== m.id);
    v.no = v.no.filter((id) => id !== m.id);
    (yes ? v.yes : v.no).push(m.id);
    this.emit({ e: 'vote', vote: v });
    this.checkVote(v);
  }

  private checkVote(v: ControlVote) {
    const online = [...this.members.values()].filter((x) => x.online).length;
    if (v.yes.length >= v.needed) this.resolveVote(v, 'passed');
    else if (v.no.length > online - v.needed) this.resolveVote(v, 'failed');
  }

  private resolveVote(v: ControlVote, outcome: 'passed' | 'failed') {
    v.resolved = outcome;
    this.emit({ e: 'vote', vote: v });
    if (outcome === 'passed') {
      const by = this.members.get(v.by) ?? null;
      const t = serverNow();
      if (v.kind === 'skip') {
        const next = this.nextItem();
        if (next) this.loadItem(next, by, true);
      } else {
        const pos = v.position ?? expectedPosition(this.playback, t, this.playback.media?.duration);
        this.applyPlayback(v.kind, pos, by, { cause: 'vote' });
      }
      this.system(`🗳 Vote passed: ${v.kind} (${v.yes.length}/${v.needed})`);
    }
    setTimeout(() => {
      this.votes = this.votes.filter((x) => x.id !== v.id);
      this.emit({ e: 'voteRemoved', id: v.id });
    }, 4000);
  }

  // ─── Chat, reactions, presence ─────────────────────────────────────────────

  private onChat(m: MemberRec, msg: { id: string; text: string; replyTo?: string | null; mediaTime: number | null }) {
    if (this.seenChat.has(msg.id)) return; // idempotent retry from the client outbox
    if (!m.buckets.chat.take()) return this.error(m, 'rate', 'Whoa, slow down a little 🙂');
    this.seenChat.add(msg.id);
    if (this.seenChat.size > 2000) this.seenChat.delete(this.seenChat.values().next().value!);
    const text = msg.text.trim();
    if (!text) return;
    const parent = msg.replyTo ? this.chat.find((c) => c.id === msg.replyTo) : null;
    const message: ChatMessage = {
      id: msg.id,
      kind: 'user',
      memberId: m.id,
      name: m.name,
      color: m.color,
      avatar: m.avatar,
      text,
      ts: Date.now(),
      mediaTime: msg.mediaTime,
      replyTo: parent ? { id: parent.id, name: parent.name, text: parent.text.slice(0, 120) } : null,
      reactions: {},
      card: null,
    };
    this.pushChat(message);
    if (this.playback.media) this.bumpStat(m, 'chat');
  }

  private pushChat(message: ChatMessage) {
    this.chat.push(message);
    if (this.chat.length > 300) this.chat.splice(0, this.chat.length - 300);
    this.emit({ e: 'chat', message });
  }

  system(text: string) {
    this.pushChat({
      id: uid(10),
      kind: 'system',
      memberId: null,
      name: 'Marquee',
      color: '#888888',
      avatar: '🎬',
      text,
      ts: Date.now(),
      mediaTime: null,
      replyTo: null,
      reactions: {},
      card: null,
    });
  }

  private onChatReact(m: MemberRec, msgId: string, emoji: string) {
    const msg = this.chat.find((c) => c.id === msgId);
    if (!msg) return;
    const list = msg.reactions[emoji] ?? [];
    msg.reactions[emoji] = list.includes(m.id) ? list.filter((x) => x !== m.id) : [...list, m.id];
    if (!msg.reactions[emoji].length) delete msg.reactions[emoji];
    this.emit({ e: 'chatUpdate', message: msg });
  }

  private onTyping(m: MemberRec) {
    const t = Date.now();
    if (t - m.lastTypingAt < 1500) return;
    m.lastTypingAt = t;
    const data = JSON.stringify({ t: 'typing', memberId: m.id } satisfies ServerMsg);
    for (const x of this.members.values()) if (x.conn && x.id !== m.id) x.conn.send(data);
  }

  private onReact(m: MemberRec, emoji: string, mediaTime: number | null) {
    if (!m.buckets.react.take()) return;
    this.reactionBatch.push({ memberId: m.id, emoji, mediaTime });
    const media = this.playback.media;
    if (mediaTime != null && media && mediaTime >= 0 && mediaTime < 6 * 3600) {
      const bins = (this.heatmap[media.id] ??= []);
      const i = Math.floor(mediaTime / HEAT_BIN_SECONDS);
      while (bins.length <= i) bins.push(0);
      bins[i]++;
      this.heatDirty = true;
      const s = this.currentStats();
      if (s) {
        const bin = (s.moments[i] ??= {});
        bin[emoji] = (bin[emoji] ?? 0) + 1;
        const mine = (s.reactions[m.id] ??= {});
        mine[emoji] = (mine[emoji] ?? 0) + 1;
        s.people[m.id] = { name: m.name, avatar: m.avatar, color: m.color };
        this.statsDirty = true;
      }
    }
  }

  private onSuggest(m: MemberRec, movieId: string) {
    const movie = this.deps.catalog.get(movieId);
    if (!movie) return;
    if (!m.buckets.chat.take()) return;
    this.pushChat({
      id: uid(10),
      kind: 'user',
      memberId: m.id,
      name: m.name,
      color: m.color,
      avatar: m.avatar,
      text: `suggests ${movie.title}`,
      ts: Date.now(),
      mediaTime: null,
      replyTo: null,
      reactions: {},
      card: { type: 'movie', movieId: movie.id, title: movie.title, poster: movie.poster, year: movie.year },
    });
    this.like(m, movieId);
  }

  // ─── Roles & settings ──────────────────────────────────────────────────────

  private onRole(m: MemberRec, op: 'transfer' | 'cohost' | 'demote' | 'kick', targetId: string) {
    const target = this.members.get(targetId);
    if (!target || target.id === m.id) return;
    if (op === 'kick') {
      if (m.role === 'member' || target.role === 'host') return this.error(m, 'forbidden', 'Not allowed');
      this.banned.add(target.token);
      this.send(target, { t: 'error', code: 'kicked', message: `${m.name} removed you from the room.`, fatal: true });
      target.conn?.close(4003, 'kicked');
      target.conn = null;
      return this.removeMember(target, 'kicked');
    }
    if (m.role !== 'host') return this.error(m, 'forbidden', 'Only the host can change roles');
    if (op === 'transfer') {
      m.role = 'cohost';
      target.role = 'host';
      this.emit({ e: 'member', member: this.pub(m) });
      this.emit({ e: 'member', member: this.pub(target) });
      this.system(`👑 ${m.name} handed the remote to ${target.name}`);
      this.emit({ e: 'toast', text: `${target.name} is now the host`, tone: 'info', icon: '👑' });
    } else {
      target.role = op === 'cohost' ? 'cohost' : 'member';
      this.emit({ e: 'member', member: this.pub(target) });
      this.system(op === 'cohost' ? `⭐ ${target.name} is now a co-host` : `${target.name} is no longer a co-host`);
    }
  }

  private onSettings(m: MemberRec, patch: Partial<Omit<RoomSettings, 'passcode'>>) {
    if (m.role === 'member') return this.error(m, 'forbidden', 'Only hosts can change room settings');
    const before = { ...this.settings };
    Object.assign(this.settings, patch);
    this.emit({ e: 'settings', settings: this.publicSettings() });
    if (patch.controlMode && patch.controlMode !== before.controlMode) {
      const label = { host: 'Host controls', everyone: 'Everyone controls', democracy: 'Democracy (votes)' }[patch.controlMode];
      this.system(`🎛 ${m.name} switched control to: ${label}`);
    }
    if (patch.syncPolicy && patch.syncPolicy !== before.syncPolicy)
      this.system(patch.syncPolicy === 'strict' ? '🤝 Strict sync: the room waits for anyone buffering' : '🏃 Relaxed sync: buffering members catch up on their own');
  }

  // ─── Polls ─────────────────────────────────────────────────────────────────

  private onPoll(m: MemberRec, msg: PollClientMsg) {
    if (msg.op === 'create') {
      if (this.polls.filter((p) => !p.closed).length >= 5) return this.error(m, 'limit', 'Too many open polls');
      const options = msg.options.map((o) => {
        const item = o.itemId ? this.playlist.find((i) => i.id === o.itemId) : null;
        const movie = o.movieId ? this.deps.catalog.get(o.movieId) : null;
        return { id: uid(6), label: o.label, movieId: movie?.id ?? item?.media.movieId ?? null, media: item?.media ?? (movie ? this.mediaFromMovie(movie) : null) };
      });
      const poll: Poll = {
        id: uid(8),
        question: msg.question,
        options,
        multi: msg.multi,
        anonymous: msg.anonymous,
        action: msg.action,
        createdBy: m.id,
        createdByName: m.name,
        createdAt: Date.now(),
        endsAt: msg.durationSec ? Date.now() + msg.durationSec * 1000 : null,
        closed: false,
        tally: Object.fromEntries(options.map((o) => [o.id, 0])),
        voters: msg.anonymous ? null : Object.fromEntries(options.map((o) => [o.id, []])),
        totalVoters: 0,
        winner: null,
      };
      this.pollVotes.set(poll.id, new Map());
      this.polls.push(poll);
      if (this.polls.length > 12) {
        const drop = this.polls.find((p) => p.closed);
        if (drop) {
          this.polls = this.polls.filter((p) => p !== drop);
          this.emit({ e: 'pollRemoved', id: drop.id });
        }
      }
      this.emit({ e: 'poll', poll });
      this.system(`📊 ${m.name} asked: ${poll.question}`);
      return;
    }
    const poll = this.polls.find((p) => p.id === msg.pollId);
    if (!poll || poll.closed) return;
    if (msg.op === 'vote') {
      const valid = msg.optionIds.filter((id) => poll.options.some((o) => o.id === id));
      const votes = this.pollVotes.get(poll.id)!;
      if (valid.length) votes.set(m.id, poll.multi ? [...new Set(valid)] : valid.slice(0, 1));
      else votes.delete(m.id);
      this.recount(poll);
      this.emit({ e: 'poll', poll });
      const online = [...this.members.values()].filter((x) => x.online).length;
      if (poll.endsAt == null && poll.totalVoters >= online && online > 1 && poll.action !== 'none') this.closePoll(poll, null);
      return;
    }
    if (poll.createdBy !== m.id && !this.canControl(m)) return this.error(m, 'forbidden', 'Only the creator or host can close this poll');
    this.closePoll(poll, m);
  }

  private recount(poll: Poll) {
    const votes = this.pollVotes.get(poll.id) ?? new Map<string, string[]>();
    poll.tally = Object.fromEntries(poll.options.map((o) => [o.id, 0]));
    if (poll.voters) poll.voters = Object.fromEntries(poll.options.map((o) => [o.id, [] as string[]]));
    for (const [memberId, opts] of votes) {
      for (const o of opts) {
        poll.tally[o]++;
        poll.voters?.[o].push(memberId);
      }
    }
    poll.totalVoters = votes.size;
  }

  private closePoll(poll: Poll, by: MemberRec | null) {
    poll.closed = true;
    const best = Math.max(0, ...Object.values(poll.tally));
    const winner = best > 0 ? poll.options.find((o) => poll.tally[o.id] === best) : undefined;
    poll.winner = winner?.id ?? null;
    this.emit({ e: 'poll', poll });
    if (!winner) return this.system(`📊 Poll closed: “${poll.question}” — no votes`);
    this.system(`📊 “${poll.question}” → ${winner.label} wins (${best} vote${best === 1 ? '' : 's'})`);
    if (poll.action !== 'none' && winner.media) {
      const item = this.addToPlaylist(by, { ...winner.media, id: uid(10) }, true);
      if (item && poll.action === 'play') this.loadItem(item, by, true);
    }
  }

  // ─── Group Pick (swipe to match) ───────────────────────────────────────────

  private like(m: MemberRec, movieId: string, like = true) {
    const t = this.taste.get(m.id) ?? { name: m.name, likes: new Set<string>(), dislikes: new Set<string>() };
    t.name = m.name;
    (like ? t.likes : t.dislikes).add(movieId);
    (like ? t.dislikes : t.likes).delete(movieId);
    this.taste.set(m.id, t);
  }

  tastes(onlyPresent = true): Taste[] {
    return [...this.taste.entries()]
      .filter(([id]) => !onlyPresent || this.members.has(id))
      .map(([memberId, t]) => ({ memberId, name: t.name, likes: [...t.likes], dislikes: [...t.dislikes] }));
  }

  private onPick(m: MemberRec, msg: PickMsg) {
    if (msg.op === 'start') {
      if (this.pick?.status === 'active') return this.error(m, 'busy', 'A Group Pick is already running');
      const exclude = new Set(this.playlist.map((i) => i.media.movieId).filter((x): x is string => !!x));
      let cands: { id: string; reason: string | null }[];
      if (msg.movieIds?.length) cands = msg.movieIds.filter((id) => this.deps.catalog.get(id)).map((id) => ({ id, reason: null }));
      else cands = this.deps.catalog.recommend(this.tastes(), exclude, 12).map((r) => ({ id: r.movie.id, reason: r.reason }));
      if (cands.length < 2) return this.error(m, 'empty', 'Not enough movies to pick from');
      this.pickSwipes = new Map();
      this.pick = {
        id: uid(8),
        candidates: cands.map((c) => c.id),
        reasons: Object.fromEntries(cands.map((c) => [c.id, c.reason])),
        participants: [...this.members.values()].filter((x) => x.online).map((x) => x.id),
        progress: {},
        status: 'active',
        match: null,
        startedBy: m.id,
        startedByName: m.name,
        startedAt: Date.now(),
        results: null,
      };
      this.emit({ e: 'pick', pick: this.pick });
      this.system(`🎲 ${m.name} started a Group Pick — swipe right on what you'd watch. First unanimous ❤ wins!`);
      return;
    }
    const pick = this.pick;
    if (!pick || pick.status !== 'active') return;
    if (msg.op === 'end') {
      if (pick.startedBy !== m.id && !this.canControl(m)) return;
      return this.finishPick(null);
    }
    if (!pick.candidates.includes(msg.movieId)) return;
    if (!pick.participants.includes(m.id)) pick.participants.push(m.id);
    const mine = this.pickSwipes.get(m.id) ?? new Map<string, boolean>();
    mine.set(msg.movieId, msg.like);
    this.pickSwipes.set(m.id, mine);
    pick.progress[m.id] = mine.size;
    this.like(m, msg.movieId, msg.like);
    this.send(m, { t: 'myPick', swipes: Object.fromEntries(mine) });
    const active = pick.participants.filter((id) => this.members.get(id)?.online);
    if (msg.like && active.length && active.every((id) => this.pickSwipes.get(id)?.get(msg.movieId) === true)) return this.finishPick(msg.movieId);
    this.checkPickProgress();
  }

  private checkPickProgress() {
    const pick = this.pick;
    if (!pick || pick.status !== 'active') return;
    const active = pick.participants.filter((id) => this.members.get(id)?.online);
    if (active.length && active.every((id) => (this.pickSwipes.get(id)?.size ?? 0) >= pick.candidates.length)) return this.finishPick(null);
    this.emit({ e: 'pick', pick });
  }

  private finishPick(match: string | null) {
    const pick = this.pick!;
    pick.results = pick.candidates
      .map((movieId) => {
        let likes = 0;
        let dislikes = 0;
        const likedBy: string[] = [];
        for (const [memberId, swipes] of this.pickSwipes) {
          const v = swipes.get(movieId);
          if (v === true) likes++, likedBy.push(this.members.get(memberId)?.name ?? '?');
          if (v === false) dislikes++;
        }
        return { movieId, likes, dislikes, likedBy };
      })
      .sort((a, b) => b.likes - a.likes || a.dislikes - b.dislikes);
    const title = (id: string) => this.deps.catalog.get(id)?.title ?? 'that one';
    const queue = (movieId: string) => {
      const movie = this.deps.catalog.get(movieId);
      const media = movie && this.mediaFromMovie(movie);
      if (media) this.addToPlaylist(null, media, true);
    };
    if (match) {
      pick.status = 'matched';
      pick.match = match;
      queue(match);
      this.system(`🎉 It's a match! Everyone wants ${title(match)} — queued up next.`);
      this.emit({ e: 'toast', text: `It's a match: ${title(match)}!`, tone: 'success', icon: '🎉' });
    } else {
      pick.status = 'done';
      const liked = pick.results.filter((r) => r.likes > 0);
      if (liked.length && liked[0].likes > (liked[1]?.likes ?? 0)) {
        pick.match = liked[0].movieId;
        queue(liked[0].movieId);
        this.system(`🏆 Group Pick winner: ${title(liked[0].movieId)} (${liked[0].likes} ❤) — queued up next.`);
      } else if (liked.length >= 2) {
        const tied = liked.filter((r) => r.likes === liked[0].likes).slice(0, 4);
        this.system(`🤝 Group Pick tie — runoff poll!`);
        const options = tied.map((r) => {
          const movie = this.deps.catalog.get(r.movieId)!;
          return { id: uid(6), label: movie.title, movieId: movie.id, media: this.mediaFromMovie(movie) };
        });
        const poll: Poll = {
          id: uid(8),
          question: 'Group Pick runoff — what are we watching?',
          options,
          multi: false,
          anonymous: false,
          action: 'queue',
          createdBy: 'system',
          createdByName: 'Marquee',
          createdAt: Date.now(),
          endsAt: Date.now() + 45_000,
          closed: false,
          tally: Object.fromEntries(options.map((o) => [o.id, 0])),
          voters: Object.fromEntries(options.map((o) => [o.id, []])),
          totalVoters: 0,
          winner: null,
        };
        this.pollVotes.set(poll.id, new Map());
        this.polls.push(poll);
        this.emit({ e: 'poll', poll });
      } else {
        this.system('🤷 No likes this round — try another Group Pick?');
      }
    }
    this.emit({ e: 'pick', pick });
  }

  // ─── Chaos (Sync Lab) ──────────────────────────────────────────────────────

  private onChaos(m: MemberRec, msg: ChaosMsg) {
    if (!this.deps.chaosEnabled) return this.error(m, 'disabled', 'Chaos mode is disabled on this server');
    if (m.role !== 'host') return this.error(m, 'forbidden', 'Only the host can inject chaos');
    const target = this.members.get(msg.target);
    if (!target) return;
    switch (msg.action) {
      case 'set':
      case 'clear': {
        const lag = msg.action === 'clear' ? 0 : msg.lagMs ?? 0;
        const jitter = msg.action === 'clear' ? 0 : msg.jitterMs ?? 0;
        target.chaos = lag || jitter ? { lagMs: lag, jitterMs: jitter } : null;
        if (target.conn) target.conn.chaos = target.chaos;
        this.system(target.chaos ? `🧪 ${m.name} gave ${target.name} ${lag} ms lag ± ${jitter} ms jitter` : `🧪 ${target.name}'s network is back to normal`);
        return;
      }
      case 'drop':
        this.system(`🧪 ${m.name} pulled the plug on ${target.name}'s connection`);
        return target.conn?.close(4001, 'chaos: connection dropped');
      case 'jump':
        this.system(`🧪 ${m.name} knocked ${target.name}'s player ${Math.abs(msg.seconds ?? 4)} s out of sync`);
        return this.send(target, { t: 'chaos', action: 'jump', seconds: msg.seconds ?? 4 });
    }
  }

  // ─── Plumbing ──────────────────────────────────────────────────────────────

  private emit(ev: RoomEvent) {
    const seq = ++this.seq;
    this.log.push({ seq, ev });
    if (this.log.length > EVENT_LOG) this.log.shift();
    const data = JSON.stringify({ t: 'ev', seq, ev } satisfies ServerMsg);
    for (const m of this.members.values()) m.conn?.send(data);
    this.dirty = true;
  }

  private broadcast(msg: ServerMsg) {
    const data = JSON.stringify(msg);
    for (const m of this.members.values()) m.conn?.send(data);
  }

  private send(m: MemberRec, msg: ServerMsg) {
    m.conn?.send(JSON.stringify(msg));
  }

  private error(m: MemberRec, code: string, message: string) {
    this.send(m, { t: 'error', code, message });
  }

  pub(m: MemberRec): Member {
    return {
      id: m.id,
      name: m.name,
      avatar: m.avatar,
      color: m.color,
      role: m.role,
      online: m.online,
      joinedAt: m.joinedAt,
      seat: m.seat,
      player: m.player,
      away: m.away,
      browsing: m.browsing,
      device: m.device,
      localFingerprint: m.localFingerprint,
      voice: m.voice,
    };
  }

  publicSettings(): PublicSettings {
    const { passcode, ...rest } = this.settings;
    return { ...rest, hasPasscode: !!passcode };
  }

  snapshot(): RoomSnapshot {
    return {
      code: this.code,
      createdAt: this.createdAt,
      settings: this.publicSettings(),
      members: [...this.members.values()].map((m) => this.pub(m)),
      playback: this.playback,
      playlist: this.playlist,
      chat: this.chat.slice(-200),
      polls: this.polls,
      votes: this.votes.filter((v) => !v.resolved),
      pick: this.pick,
      upNext: this.upNext,
      heatmap: this.heatmap,
      stats: this.stats,
    };
  }

  get onlineCount(): number {
    let n = 0;
    for (const m of this.members.values()) if (m.online) n++;
    return n;
  }

  // ─── Persistence ───────────────────────────────────────────────────────────

  toJSON() {
    return {
      code: this.code,
      createdAt: this.createdAt,
      settings: this.settings,
      members: [...this.members.values()].map((m) => ({ ...this.pub(m), token: m.token })),
      playback: this.playback,
      playlist: this.playlist,
      currentItemId: this.currentItemId,
      chat: this.chat.slice(-200),
      polls: this.polls,
      pollVotes: [...this.pollVotes.entries()].map(([id, v]): [string, [string, string[]][]] => [id, [...v.entries()]]),
      pick: this.pick,
      pickSwipes: [...this.pickSwipes.entries()].map(([id, v]): [string, [string, boolean][]] => [id, [...v.entries()]]),
      heatmap: this.heatmap,
      taste: [...this.taste.entries()].map(([id, t]): [string, { name: string; likes: string[]; dislikes: string[] }] => [id, { name: t.name, likes: [...t.likes], dislikes: [...t.dislikes] }]),
      banned: [...this.banned],
      upNext: this.upNext,
      stats: this.stats,
    };
  }

  static fromJSON(data: ReturnType<Room['toJSON']>, deps: RoomDeps): Room {
    const r = new Room(data.code, data.settings, deps);
    r.createdAt = data.createdAt;
    const t = serverNow();
    for (const m of data.members) {
      r.members.set(m.id, {
        ...m,
        online: false,
        player: 'idle',
        conn: null,
        telemetry: { drift: null, rtt: null, offset: null, rate: null },
        bufferingSince: null,
        releasedUntil: 0,
        // Give everyone a full grace window to reconnect after a server restart.
        offlineSince: t,
        loadingAt: t,
        voice: 'off',
        chaos: null,
        buckets: newBuckets(),
        lastTypingAt: 0,
      });
    }
    r.playback = { ...data.playback, hold: null };
    r.playlist = data.playlist;
    r.currentItemId = data.currentItemId;
    r.chat = data.chat;
    r.polls = data.polls;
    r.pollVotes = new Map(data.pollVotes.map(([id, v]) => [id, new Map(v)]));
    r.pick = data.pick;
    r.pickSwipes = new Map(data.pickSwipes.map(([id, v]) => [id, new Map(v)]));
    r.heatmap = data.heatmap;
    r.taste = new Map(data.taste.map(([id, x]) => [id, { name: x.name, likes: new Set(x.likes), dislikes: new Set(x.dislikes) }]));
    r.banned = new Set(data.banned);
    r.upNext = data.upNext;
    r.stats = data.stats ?? [];
    r.playback.rate ??= 1;
    r.emptySince = Date.now();
    r.system('🔄 Server restarted — welcome back! Playback continued right where it was.');
    return r;
  }
}

export type { MemberRec };
