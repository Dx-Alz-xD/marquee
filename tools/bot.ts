// Headless Marquee client for load / latency testing. It speaks the real
// protocol, syncs its clock exactly like the browser, and drives a *simulated*
// player through the very same correction ladder (shared/sync.ts). The fake
// player has realistic imperfections: clock skew (decoder drift), seek latency,
// start latency and position read noise. Optional network impairment adds
// lag/jitter/retransmit spikes in both directions, order-preserving.
import WebSocket from 'ws';
import { PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from '../shared/protocol';
import { ClockEstimator, SYNC, clockSample, decideCorrection, expectedPosition, isScheduled } from '../shared/sync';
import type { PlaybackState } from '../shared/types';
import { uid } from '../shared/util';
import { DelayQueue } from '../shared/delay-queue';

export interface NetProfile {
  lagMs: number; // round-trip added (split half each way)
  jitterMs: number; // + U(0, jitter) per direction
  spikePct: number; // probability of a 200–400 ms retransmit-like spike
}

export const NET = {
  lan: { lagMs: 0, jitterMs: 0, spikePct: 0 },
  wifi: { lagMs: 8, jitterMs: 12, spikePct: 0.002 },
  wan: { lagMs: 60, jitterMs: 25, spikePct: 0.005 },
  bad: { lagMs: 180, jitterMs: 90, spikePct: 0.02 },
} satisfies Record<string, NetProfile>;

const now = () => performance.timeOrigin + performance.now();
const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** Simulated media element. */
class FakePlayer {
  private pos = 0;
  private at = performance.now();
  private playing = false;
  rate = 1;
  private stallUntil = 0;
  /** Device clock skew: real decoders drift by fractions of a percent. */
  private skew = 1 + rand(-0.004, 0.004);

  time(): number {
    const t = performance.now();
    if (!this.playing || t < this.stallUntil) return this.pos;
    return this.pos + ((t - Math.max(this.at, this.stallUntil)) / 1000) * this.rate * this.skew;
  }
  private freeze() {
    this.pos = this.time();
    this.at = Math.max(performance.now(), this.stallUntil);
  }
  play() {
    if (this.playing) return;
    this.freeze();
    this.playing = true;
    this.stallUntil = Math.max(this.stallUntil, performance.now() + rand(5, 30)); // decoder start latency
    this.at = this.stallUntil;
  }
  pause() {
    this.freeze();
    this.playing = false;
  }
  seek(t: number, latencyMs: number) {
    this.pos = Math.max(0, t);
    this.stallUntil = performance.now() + latencyMs;
    this.at = this.stallUntil;
  }
  setRate(r: number) {
    this.freeze();
    this.rate = r;
  }
  get paused() {
    return !this.playing;
  }
  get seeking() {
    return performance.now() < this.stallUntil;
  }
}

export interface BotStats {
  delivery: number[]; // ms, click → received (server clock)
  apply: number[];
  drift: number[]; // |ms| settled samples
  resumes: number;
  welcomes: number;
  chatSeen: Map<string, number>;
  errors: string[];
}

export class Bot {
  ws: WebSocket | null = null;
  readonly clock = new ClockEstimator();
  readonly player = new FakePlayer();
  readonly stats: BotStats = { delivery: [], apply: [], drift: [], resumes: 0, welcomes: 0, chatSeen: new Map(), errors: [] };
  state: PlaybackState | null = null;
  you: string | null = null;
  token: string | undefined;
  seq = 0;
  role: string | null = null;
  connected = false;
  private outQ = new DelayQueue();
  private inQ = new DelayQueue();
  /** Like the browser client: chat queued while offline, replayed on reconnect (server dedupes by id). */
  private outbox: ClientMsg[] = [];
  private timers: NodeJS.Timeout[] = [];
  private lastSeekAt = 0;
  private correcting = false;
  private seekLead = 0.08;
  private lastChange = 0;
  private closed = false;
  private readyResolve: (() => void) | null = null;

  constructor(
    readonly url: string,
    readonly room: string,
    readonly name: string,
    readonly net: NetProfile = NET.lan,
  ) {}

  serverNow() {
    return now() + this.clock.offset;
  }

  private delay() {
    let d = this.net.lagMs / 2 + Math.random() * this.net.jitterMs;
    if (Math.random() < this.net.spikePct) d += rand(200, 400);
    return d;
  }

  connect(): Promise<void> {
    this.closed = false;
    const ready = new Promise<void>((r) => (this.readyResolve = r));
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.on('open', () => {
      this.send({
        t: 'hello',
        v: PROTOCOL_VERSION,
        room: this.room,
        name: this.name,
        avatar: '🤖',
        color: '#4d96ff',
        token: this.token,
        lastSeq: this.token && this.seq ? this.seq : undefined,
        device: 'desktop',
      });
      for (let i = 0; i < 8; i++) setTimeout(() => this.ping(), i * 40);
    });
    ws.on('message', (raw) => {
      const recvAt = this.serverNow();
      const msg = JSON.parse(raw.toString()) as ServerMsg;
      this.inQ.push(this.delay(), () => this.onMessage(msg, recvAt));
    });
    ws.on('close', () => {
      this.connected = false;
    });
    ws.on('error', (e) => this.stats.errors.push(e.message));
    if (!this.timers.length) {
      this.timers.push(setInterval(() => this.ping(), 1000));
      this.timers.push(setInterval(() => this.step(), SYNC.tickMs));
      this.timers.push(setInterval(() => this.report(), 2000));
      this.timers.push(setInterval(() => this.sampleDrift(), 500));
    }
    return ready;
  }

  send(msg: ClientMsg) {
    const data = JSON.stringify(msg);
    const ws = this.ws;
    if (msg.t === 'chat' && (!this.connected || ws?.readyState !== WebSocket.OPEN)) {
      this.outbox.push(msg);
      return;
    }
    this.outQ.push(this.delay(), () => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(data);
      else if (msg.t === 'chat') this.outbox.push(msg);
    });
  }

  private flush() {
    for (const m of this.outbox.splice(0)) this.send(m);
  }

  private ping() {
    if (this.ws?.readyState === WebSocket.OPEN) this.send({ t: 'ping', c0: now() });
  }

  private onMessage(msg: ServerMsg, recvAtRaw: number) {
    // recvAt must be on the server clock *after* the simulated inbound delay
    const recvAt = this.serverNow();
    void recvAtRaw;
    switch (msg.t) {
      case 'welcome':
        this.stats.welcomes++;
        this.you = msg.you;
        this.token = msg.token;
        this.seq = msg.seq;
        this.connected = true;
        this.role = msg.snapshot.members.find((m) => m.id === msg.you)?.role ?? null;
        for (const c of msg.snapshot.chat) this.stats.chatSeen.set(c.id, (this.stats.chatSeen.get(c.id) ?? 0) + 0);
        this.applyPlayback(msg.snapshot.playback, recvAt, true);
        this.flush();
        this.readyResolve?.();
        break;
      case 'resumed':
        this.stats.resumes++;
        this.connected = true;
        this.flush();
        this.readyResolve?.();
        break;
      case 'ev':
        if (msg.seq <= this.seq) return;
        this.seq = msg.seq;
        if (msg.ev.e === 'playback') this.applyPlayback(msg.ev.playback, recvAt, false);
        if (msg.ev.e === 'chat') this.stats.chatSeen.set(msg.ev.message.id, (this.stats.chatSeen.get(msg.ev.message.id) ?? 0) + 1);
        if (msg.ev.e === 'member' && msg.ev.member.id === this.you) this.role = msg.ev.member.role;
        break;
      case 'pong':
        this.clock.add(clockSample(msg.c0, msg.s1, msg.s2, now()));
        break;
      case 'error':
        this.stats.errors.push(`${msg.code}: ${msg.message}`);
        break;
    }
  }

  private applyPlayback(p: PlaybackState, recvAt: number, snapshot: boolean) {
    if (this.state && p.version < this.state.version) return;
    const prevVersion = this.state?.version;
    this.state = p;
    if (p.version !== prevVersion) this.lastChange = performance.now();
    this.step(true);
    if (!snapshot && p.cmdId && p.by !== this.you && p.version !== prevVersion && p.issuedAt) {
      const appliedAt = this.serverNow();
      this.stats.delivery.push(recvAt - p.issuedAt);
      this.stats.apply.push(appliedAt - recvAt);
      this.send({ t: 'ack', version: p.version, recvAt, appliedAt });
    }
  }

  private step(force = false) {
    const p = this.state;
    if (!p?.media) return;
    const pl = this.player;
    const t = this.serverNow();
    const actual = pl.time() + rand(-0.004, 0.004); // currentTime read noise
    if (p.status === 'paused' || isScheduled(p, t)) {
      if (!pl.paused) pl.pause();
      if (Math.abs(actual - p.position) > SYNC.pausedTolerance) pl.seek(p.position, rand(20, 80));
      if (this.correcting) pl.setRate(1), (this.correcting = false);
      return;
    }
    const exp = expectedPosition(p, t);
    const drift = actual - exp;
    if (pl.paused) {
      if (Math.abs(drift) > 0.25) this.seekTo(exp + this.seekLead);
      pl.play();
      return;
    }
    if (pl.seeking || (!force && performance.now() - this.lastSeekAt < SYNC.seekCooldownMs)) return;
    const c = decideCorrection({ drift, fineRate: true, correcting: this.correcting, expected: exp, seekLead: this.seekLead });
    if (c.kind === 'seek') {
      pl.setRate(1);
      this.correcting = false;
      this.seekTo(c.target);
    } else if (c.kind === 'rate') {
      pl.setRate(c.rate);
      this.correcting = true;
    } else if (this.correcting) {
      pl.setRate(1);
      this.correcting = false;
    }
  }

  private seekTo(target: number) {
    const latency = rand(30, 120);
    this.player.seek(target, latency);
    this.lastSeekAt = performance.now();
    this.seekLead = 0.7 * this.seekLead + 0.3 * (latency / 1000 + 0.02);
  }

  currentDrift(): number | null {
    const p = this.state;
    if (!p?.media || p.status !== 'playing' || isScheduled(p, this.serverNow()) || this.player.seeking) return null;
    return (this.player.time() - expectedPosition(p, this.serverNow())) * 1000;
  }

  private sampleDrift() {
    // "After correction": skip the first 3 s after any change (that's the correction window).
    if (performance.now() - this.lastChange < 3000) return;
    const d = this.currentDrift();
    if (d != null) this.stats.drift.push(Math.abs(d));
    if (d != null && Math.abs(d) > 5000 && process.env.BOT_DEBUG)
      console.log('[bot] huge drift', this.name, Math.round(d), JSON.stringify({ st: this.state?.status, pos: this.state?.position, at: this.state?.at, now: this.serverNow(), v: this.state?.version, t: this.player.time(), paused: this.player.paused, off: this.clock.offset }));
  }

  private report() {
    if (!this.connected) return;
    const d = this.currentDrift();
    this.send({
      t: 'report',
      player: this.player.seeking ? 'buffering' : 'ready',
      drift: d == null ? null : Math.round(d * 10) / 10,
      rtt: this.clock.rtt,
      offset: this.clock.offset,
      rate: this.player.rate,
      away: false,
    });
  }

  command(kind: 'play' | 'pause' | 'seek', position?: number) {
    const p = this.state;
    if (!p) return;
    const issuedAt = this.serverNow();
    const pos = kind === 'seek' ? position ?? 0 : this.player.time();
    // optimistic local apply, like the browser
    if (kind === 'pause') this.player.pause();
    if (kind === 'play') this.player.play();
    if (kind === 'seek') this.seekTo(pos);
    this.send({ t: 'cmd', cmdId: uid(8), kind, position: pos, issuedAt, baseVersion: p.version });
  }

  chat(text: string, id = uid(12)) {
    this.send({ t: 'chat', id, text, mediaTime: null });
    return id;
  }

  /** Simulate a network drop: kill the socket, come back after `downMs` and resume. */
  async drop(downMs: number) {
    this.ws?.terminate();
    this.connected = false;
    await new Promise((r) => setTimeout(r, downMs));
    await this.connect();
  }

  close() {
    this.closed = true;
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.ws?.close();
  }
}
