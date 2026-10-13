// ─────────────────────────────────────────────────────────────────────────────
// SyncEngine — keeps the local player glued to the room's playback anchor.
//
//  • Applies server playback states the instant they arrive (and acks them so
//    the server can measure click→apply propagation latency).
//  • Applies the local user's own commands optimistically, then reconciles.
//  • Runs the correction ladder every 200 ms (dead-zone → rate nudge → seek).
//  • Starts countdowns on a precise timer so every device lands on one frame.
//  • Learns this device's seek latency and seeks that far ahead.
// ─────────────────────────────────────────────────────────────────────────────
import type { ServerMsg } from '@shared/protocol';
import { SYNC, decideCorrection, expectedPosition, isScheduled } from '@shared/sync';
import type { Media, PlaybackState, PlayerStatus } from '@shared/types';
import { uid } from '@shared/util';
import type { RoomClient } from '../net/client';
import type { PlayerAdapter } from '../players/adapter';
import { Html5Adapter } from '../players/html5';
import { YouTubeAdapter } from '../players/youtube';
import { canControl, useRoom } from '../store';

export class SyncEngine {
  private adapter: PlayerAdapter | null = null;
  private host: HTMLElement | null = null;
  private slot: HTMLDivElement | null = null;
  private mediaKey: string | null = null;
  private ready = false;
  private loadToken = 0;
  private state: PlaybackState | null = null;
  private pending: { cmdId: string; state: PlaybackState; baseVersion: number; until: number } | null = null;
  private correcting = false;
  private lastSeekAt = 0;
  private seekStartedAt: number | null = null;
  private seekLead = 0.12;
  private playLead = 0.04;
  private playRequestedAt: number | null = null;
  private startTimer: number | null = null;
  private startArmedFor = -1;
  private bufferingSince: number | null = null;
  private status: PlayerStatus = 'idle';
  private durationReported: string | null = null;
  private detour = false;
  private timers: number[] = [];
  private lastDrift: number | null = null;
  private volume = 1;
  private muted = false;
  private destroyed = false;
  private duck = 1;
  private duckTarget = 1;
  private duckTimer: number | null = null;

  constructor(private readonly client: RoomClient) {
    client.onMessage((msg, recvAt) => this.onServer(msg, recvAt));
    this.timers.push(window.setInterval(() => this.step(), SYNC.tickMs));
    this.timers.push(window.setInterval(() => this.report(), 2000));
    document.addEventListener('visibilitychange', this.onVisible);
  }

  private onVisible = () => {
    if (document.visibilityState === 'visible') this.step(true);
    this.report();
  };

  // ─── Server input ──────────────────────────────────────────────────────────

  private onServer(msg: ServerMsg, recvAt: number) {
    if (msg.t === 'welcome') this.onPlayback(msg.snapshot.playback, recvAt, true);
    else if (msg.t === 'ev' && msg.ev.e === 'playback') this.onPlayback(msg.ev.playback, recvAt, false);
    else if (msg.t === 'cmdResult') this.onCmdResult(msg);
    else if (msg.t === 'chaos' && msg.action === 'jump' && this.adapter && this.ready) {
      this.adapter.seek(this.adapter.getTime() + msg.seconds);
      useRoom.getState().toast(`Chaos: your player was knocked ${msg.seconds}s out of sync — watch it recover`, 'warn', '🧪');
    }
  }

  private onPlayback(p: PlaybackState, recvAt: number, fromSnapshot: boolean) {
    const prev = this.state;
    if (prev && p.version < prev.version) return;
    this.state = p;
    if (this.pending && (p.cmdId === this.pending.cmdId || p.version > this.pending.baseVersion)) this.pending = null;

    const st = useRoom.getState();
    if (!fromSnapshot && p.concurrentWith && p.version !== prev?.version && p.byName)
      st.toast(`${p.byName} and ${p.concurrentWith} acted at the same moment — went with ${p.byName}'s (latest)`, 'info', '⚡');

    const key = mediaKeyOf(p.media);
    if (key !== this.mediaKey) {
      void this.load(p.media);
      return;
    }
    if (!this.ready || this.detour) return;
    this.step(true);
    // Propagation ack: only for other members' commands that we actually applied.
    if (!fromSnapshot && p.cmdId && p.by !== st.you && p.version !== prev?.version) {
      this.client.send({ t: 'ack', version: p.version, recvAt, appliedAt: this.client.serverNow() });
    }
  }

  private onCmdResult(r: Extract<ServerMsg, { t: 'cmdResult' }>) {
    const st = useRoom.getState();
    if (this.pending?.cmdId === r.cmdId && (!r.ok || r.noop)) {
      this.pending = null;
      this.step(true);
    }
    if (r.reason === 'vote') st.toast('Vote started — the room decides', 'info', '🗳');
    else if (!r.ok && r.reason) st.toast(r.reason, 'warn');
    else if (r.noop && r.reason) st.toast(r.reason, 'info');
  }

  // ─── Media lifecycle ───────────────────────────────────────────────────────

  mount(host: HTMLElement) {
    this.host = host;
    if (this.state?.media && !this.adapter) void this.load(this.state.media);
  }

  /** Re-evaluate the current media (e.g. after the user picked their local file). */
  reload() {
    this.mediaKey = null;
    if (this.state) void this.load(this.state.media);
  }

  private async load(media: Media | null) {
    const token = ++this.loadToken;
    this.teardownAdapter();
    this.mediaKey = mediaKeyOf(media);
    this.durationReported = null;
    this.correcting = false;
    this.detour = false;
    useRoom.getState().setLocal({ detour: false, error: null, duration: media?.duration ?? null, time: 0, blocked: false });
    if (!media) return this.setStatus('idle');
    if (!this.host) return; // mounted later

    let src: { url: string; hls: boolean } | null = null;
    if (media.kind === 'local') {
      const lf = useRoom.getState().localFile;
      if (!lf || !(lf.fingerprint === media.local?.fingerprint || lf.acceptedFor === media.id)) return this.setStatus('needs-file');
      src = { url: lf.url, hls: false };
    } else if (media.kind === 'file' || media.kind === 'hls') {
      src = { url: media.url!, hls: media.kind === 'hls' || /\.m3u8(\?|$)/i.test(media.url!) };
    }

    const slot = document.createElement('div');
    slot.className = 'absolute inset-0';
    this.host.appendChild(slot);
    this.slot = slot;
    const a: PlayerAdapter = media.kind === 'youtube' ? new YouTubeAdapter(slot, media.youtubeId!) : new Html5Adapter(slot, src!);
    this.adapter = a;
    this.setStatus('loading');

    a.on('seeked', () => a.kind === 'html5' && this.learnSeek());
    a.on('playing', () => {
      if (a.kind === 'youtube') this.learnSeek();
      if (this.playRequestedAt != null) {
        const dt = (performance.now() - this.playRequestedAt) / 1000;
        if (dt < 1) this.playLead = Math.min(0.25, Math.max(0.01, 0.7 * this.playLead + 0.3 * dt));
        this.playRequestedAt = null;
      }
    });
    a.on('ended', () => this.state?.media && this.client.send({ t: 'ended', mediaId: this.state.media.id }));
    a.on('error', (m) => {
      if (token !== this.loadToken) return;
      useRoom.getState().setLocal({ error: m ?? 'Playback error' });
      this.setStatus('error');
    });

    try {
      await a.load();
    } catch (e) {
      if (token !== this.loadToken) return;
      useRoom.getState().setLocal({ error: (e as Error).message });
      return this.setStatus('error');
    }
    if (token !== this.loadToken) return;
    // Pre-buffer YouTube while the room is paused or counting down, so the start lands on time.
    const p = this.state;
    if (a instanceof YouTubeAdapter && p && (p.status === 'paused' || isScheduled(p, this.client.serverNow()))) {
      await a.warmup(p.position);
      if (token !== this.loadToken) return;
    }
    a.setVolume(this.volume * this.duck);
    a.setMuted(this.muted);
    this.ready = true;
    this.setStatus('ready');
    this.step(true);
    this.report();
  }

  private teardownAdapter() {
    this.ready = false;
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
    this.startArmedFor = -1;
    this.adapter?.destroy();
    this.adapter = null;
    this.slot?.remove();
    this.slot = null;
  }

  private learnSeek() {
    if (this.seekStartedAt == null) return;
    const dt = (performance.now() - this.seekStartedAt) / 1000;
    this.seekStartedAt = null;
    if (dt > 3) return; // outlier (stall), don't learn from it
    this.seekLead = Math.min(1.2, Math.max(0.03, 0.7 * this.seekLead + 0.3 * (dt + 0.02)));
    useRoom.getState().setLocal({ seekLead: this.seekLead });
  }

  private seekTo(t: number) {
    this.adapter!.seek(t);
    this.lastSeekAt = performance.now();
    this.seekStartedAt = performance.now();
  }

  // ─── The loop ──────────────────────────────────────────────────────────────

  private effective(): PlaybackState | null {
    if (this.pending && performance.now() < this.pending.until) return this.pending.state;
    return this.state;
  }

  step(force = false) {
    const a = this.adapter;
    const p = this.effective();
    if (!a || !this.ready || !p?.media) return;
    const store = useRoom.getState();
    const actual = a.getTime();
    const dur = a.duration ?? p.media.duration ?? null;
    this.trackBuffering(a);

    if (this.detour) {
      store.setLocal({ time: actual, duration: dur, drift: null, rate: 1 });
      return;
    }

    const now = this.client.serverNow();
    // The room's chosen speed (synced speed control); corrections multiply on top of it.
    const base = p.rate || 1;
    let rate = base;
    let drift: number;
    if (p.status === 'paused' || isScheduled(p, now)) {
      if (!a.paused) a.pause();
      a.setRate(base);
      this.correcting = false;
      drift = actual - p.position;
      if (Math.abs(drift) > SYNC.pausedTolerance && performance.now() - this.lastSeekAt > 350) this.seekTo(p.position);
      if (isScheduled(p, now)) this.armStart(p, now);
    } else {
      const exp = expectedPosition(p, now, dur);
      drift = actual - exp;
      const atEnd = dur != null && exp >= dur - 0.1;
      if (a.paused && !atEnd) {
        a.setRate(base);
        if (Math.abs(drift) > 0.25 && performance.now() - this.lastSeekAt > 350) this.seekTo(exp + this.seekLead * base);
        this.tryPlay();
      } else if (force || performance.now() - this.lastSeekAt > SYNC.seekCooldownMs) {
        const c = decideCorrection({ drift, fineRate: a.caps.fineRate, correcting: this.correcting, expected: exp, seekLead: this.seekLead * base });
        if (c.kind === 'seek' && performance.now() - this.lastSeekAt > SYNC.seekCooldownMs) {
          a.setRate(base);
          this.correcting = false;
          this.seekTo(c.target);
        } else if (c.kind === 'rate') {
          rate = Math.round(base * c.rate * 1000) / 1000;
          a.setRate(rate);
          this.correcting = true;
        } else if (c.kind === 'none') {
          a.setRate(base);
          this.correcting = false;
        }
      } else if (this.correcting) {
        rate = (a as Html5Adapter).video?.playbackRate ?? base;
      }
    }
    this.lastDrift = drift;
    store.setLocal({ time: actual, duration: dur, drift: Math.round(drift * 1000), rate, baseRate: base });
    if (dur && this.state?.media && this.durationReported !== this.state.media.id) this.report();
  }

  /** Countdown starts: fire play() on a dedicated timer, early by this device's measured start latency. */
  private armStart(p: PlaybackState, now: number) {
    const msLeft = p.at - now;
    if (msLeft > 700 || this.startArmedFor === p.version) return;
    this.startArmedFor = p.version;
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = window.setTimeout(
      () => {
        this.startTimer = null;
        if (this.state?.version !== p.version || !this.adapter) return;
        this.tryPlay();
      },
      Math.max(0, msLeft - this.playLead * 1000),
    );
  }

  private tryPlay() {
    const a = this.adapter;
    if (!a || (this.playRequestedAt != null && performance.now() - this.playRequestedAt < 1500)) return;
    this.playRequestedAt = performance.now();
    a.play().catch((err: DOMException) => {
      this.playRequestedAt = null;
      if (err?.name !== 'NotAllowedError') return;
      // Autoplay blocked: keep sync by playing muted, ask for a tap to unmute.
      a.setMuted(true);
      this.muted = true;
      useRoom.getState().setLocal({ muted: true, blocked: true });
      a.play().catch(() => this.setStatus('blocked'));
    });
  }

  private trackBuffering(a: PlayerAdapter) {
    if (this.status === 'error' || this.status === 'needs-file') return;
    if (a.buffering) {
      this.bufferingSince ??= performance.now();
      if (performance.now() - this.bufferingSince > 400) this.setStatus(this.detour ? 'detour' : 'buffering');
    } else {
      this.bufferingSince = null;
      this.setStatus(this.detour ? 'detour' : 'ready');
    }
  }

  private setStatus(s: PlayerStatus) {
    if (this.destroyed || this.status === s) return;
    this.status = s;
    useRoom.getState().setLocal({ status: s });
    this.report();
  }

  private report() {
    const st = useRoom.getState();
    if (this.destroyed || st.conn !== 'connected') return;
    const p = this.state;
    const media = p?.media;
    const dur = this.adapter?.duration;
    let duration: { mediaId: string; duration: number } | undefined;
    if (media && dur && this.durationReported !== media.id) {
      duration = { mediaId: media.id, duration: dur };
      this.durationReported = media.id;
    }
    const playing = p?.status === 'playing' && !isScheduled(p, this.client.serverNow());
    this.client.send({
      t: 'report',
      player: this.status,
      drift: playing && this.ready && !this.detour && this.lastDrift != null ? Math.round(this.lastDrift * 10000) / 10 : null,
      rtt: this.client.clock.synced ? Math.round(this.client.clock.rtt * 10) / 10 : null,
      offset: this.client.clock.synced ? Math.round(this.client.clock.offset * 10) / 10 : null,
      rate: useRoom.getState().local.rate,
      away: document.visibilityState === 'hidden',
      duration,
      localFingerprint: st.localFile?.fingerprint ?? null,
    });
  }

  // ─── User intent ───────────────────────────────────────────────────────────

  command(kind: 'play' | 'pause' | 'seek', position?: number) {
    const st = useRoom.getState();
    if (this.detour) return this.detourCommand(kind, position);
    const p = this.state;
    if (!p?.media) return;
    const now = this.client.serverNow();
    const actual = this.adapter && this.ready ? this.adapter.getTime() : expectedPosition(p, now);
    const pos = kind === 'seek' ? Math.max(0, position ?? 0) : actual;
    const cmdId = uid(8);
    const sent = this.client.send({ t: 'cmd', cmdId, kind, position: pos, issuedAt: now, baseVersion: p.version });
    if (!sent) return st.toast('You’re offline — reconnecting…', 'warn', '📡');
    if (!canControl(st)) return; // democracy → server opens a vote; otherwise it will refuse
    const optimistic: PlaybackState = {
      ...p,
      status: kind === 'play' ? 'playing' : kind === 'pause' ? 'paused' : p.status,
      position: kind === 'play' ? (p.status === 'paused' ? (p.ended ? 0 : p.position) : pos) : pos,
      at: now,
      hold: null,
      ended: false,
    };
    this.pending = { cmdId, state: optimistic, baseVersion: p.version, until: performance.now() + 2500 };
    this.step(true);
  }

  togglePlay() {
    const p = this.effective();
    if (this.detour) return this.detourCommand(this.adapter?.paused ? 'play' : 'pause');
    if (!p) return;
    const playing = p.status === 'playing';
    this.command(playing ? 'pause' : 'play');
  }

  countdown() {
    this.client.send({ t: 'countdown', seconds: 3 });
  }

  /** Synced speed for everyone (server re-anchors so nobody jumps). */
  speed(rate: number) {
    this.client.send({ t: 'speed', rate });
  }

  /** Jump to a moment privately (catch-up / Wrap highlights): a Personal Detour, then GO LIVE. */
  watchMoment(t: number) {
    if (!this.adapter || !this.ready) return;
    if (!this.detour) this.startDetour();
    this.adapter.seek(Math.max(0, t));
    void this.adapter.play().catch(() => {});
  }

  // ─── Personal Detour: step out of sync, then snap back LIVE ────────────────

  startDetour() {
    if (!this.adapter || !this.ready) return;
    this.detour = true;
    this.adapter.setRate(1);
    this.correcting = false;
    useRoom.getState().setLocal({ detour: true, drift: null });
    this.setStatus('detour');
  }

  endDetour() {
    this.detour = false;
    useRoom.getState().setLocal({ detour: false });
    this.setStatus('ready');
    this.step(true);
  }

  private detourCommand(kind: 'play' | 'pause' | 'seek', position?: number) {
    const a = this.adapter;
    if (!a) return;
    if (kind === 'play') void a.play().catch(() => {});
    if (kind === 'pause') a.pause();
    if (kind === 'seek' && position != null) a.seek(position);
  }

  /** Where the room is right now (for the LIVE pill / detour distance). */
  roomPosition(): number | null {
    const p = this.state;
    if (!p?.media) return null;
    return expectedPosition(p, this.client.serverNow(), this.adapter?.duration ?? p.media.duration);
  }

  displayTime(): number {
    return this.adapter && this.ready ? this.adapter.getTime() : this.roomPosition() ?? 0;
  }

  get isDetour() {
    return this.detour;
  }

  setVolume(v: number) {
    this.volume = v;
    this.adapter?.setVolume(v * this.duck);
    useRoom.getState().setLocal({ volume: v });
  }

  /**
   * Voice ducking: while someone else is talking, glide the movie down to 25 %
   * of your volume, then back up when they stop.
   */
  setDucked(on: boolean) {
    const target = on ? 0.25 : 1;
    if (this.duckTarget === target) return;
    this.duckTarget = target;
    if (this.duckTimer) clearInterval(this.duckTimer);
    const from = this.duck;
    const t0 = performance.now();
    const ms = on ? 250 : 700;
    this.duckTimer = window.setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      this.duck = from + (target - from) * k;
      this.adapter?.setVolume(this.volume * this.duck);
      if (k >= 1 && this.duckTimer) {
        clearInterval(this.duckTimer);
        this.duckTimer = null;
      }
    }, 30);
    useRoom.getState().setLocal({ ducked: on });
  }

  setMuted(m: boolean) {
    this.muted = m;
    this.adapter?.setMuted(m);
    useRoom.getState().setLocal({ muted: m, blocked: m ? useRoom.getState().local.blocked : false });
    if (!m) this.step(true);
  }

  videoElement(): HTMLVideoElement | null {
    return this.adapter instanceof Html5Adapter ? this.adapter.video : null;
  }

  destroy() {
    this.destroyed = true;
    this.loadToken++; // invalidate any in-flight load so it can't write into the shared store
    this.timers.forEach(clearInterval);
    if (this.duckTimer) clearInterval(this.duckTimer);
    document.removeEventListener('visibilitychange', this.onVisible);
    this.teardownAdapter();
  }
}

function mediaKeyOf(m: Media | null): string | null {
  return m ? `${m.id}` : null;
}
