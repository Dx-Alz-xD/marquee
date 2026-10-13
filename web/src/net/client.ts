// WebSocket client: handshake + resume, NTP-style clock sync, reconnect with
// exponential backoff + jitter, an outbox for idempotent messages, and a
// watchdog for half-open connections.
import { PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from '@shared/protocol';
import { ClockEstimator, clockSample, expectedPosition } from '@shared/sync';
import { isMobile, tokenStore, type Identity } from '../lib/util';
import { useRoom } from '../store';

const FATAL_CLOSE = new Set([4003, 4004, 4005, 4006]);
/** Message types worth replaying after a reconnect (idempotent server-side). */
const QUEUEABLE = new Set<ClientMsg['t']>(['chat', 'chatReact', 'poll', 'vote', 'pick', 'pl', 'suggest', 'profile', 'settings']);

type Listener = (msg: ServerMsg, recvAt: number) => void;

export class RoomClient {
  readonly clock = new ClockEstimator();
  private ws: WebSocket | null = null;
  private seq = 0;
  private attempts = 0;
  private outbox: ClientMsg[] = [];
  private timers: number[] = [];
  private reconnectTimer: number | null = null;
  private lastPong = performance.now();
  private closed = false;
  private listeners: Listener[] = [];
  connectedAt = 0;

  constructor(
    readonly code: string,
    private identity: Identity,
    private passcode?: string,
  ) {}

  /** Server-clock "now" in ms. */
  serverNow(): number {
    return performance.timeOrigin + performance.now() + this.clock.offset;
  }

  onMessage(l: Listener) {
    this.listeners.push(l);
  }

  offMessage(l: Listener) {
    this.listeners = this.listeners.filter((x) => x !== l);
  }

  connect() {
    this.closed = false;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    useRoom.setState({ conn: this.seq ? 'reconnecting' : 'connecting' });

    ws.onopen = () => {
      this.attempts = 0;
      this.lastPong = performance.now();
      const token = tokenStore.get(this.code) ?? undefined;
      this.rawSend({
        t: 'hello',
        v: PROTOCOL_VERSION,
        room: this.code,
        name: this.identity.name,
        avatar: this.identity.avatar,
        color: this.identity.color,
        token,
        lastSeq: token && this.seq ? this.seq : undefined,
        passcode: this.passcode,
        device: isMobile() ? 'mobile' : 'desktop',
      });
      this.burst();
    };

    ws.onmessage = (e) => {
      const recvAt = this.serverNow();
      let msg: ServerMsg;
      try {
        msg = JSON.parse(e.data as string);
      } catch {
        return;
      }
      this.handle(msg, recvAt);
    };

    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closed) return;
      if (FATAL_CLOSE.has(e.code)) {
        useRoom.setState({ conn: 'closed' });
        return;
      }
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose follows */
    };

    if (!this.timers.length) {
      // Periodic clock samples double as an application-level heartbeat.
      this.timers.push(window.setInterval(() => this.ping(), 2500));
      this.timers.push(
        window.setInterval(() => {
          // Watchdog: no pong for 9 s ⇒ the socket is half-open. Kill it and reconnect.
          if (this.ws?.readyState === WebSocket.OPEN && performance.now() - this.lastPong > 9000) this.ws.close(4100, 'watchdog');
        }, 3000),
      );
      window.addEventListener('online', this.onOnline);
      document.addEventListener('visibilitychange', this.onVisible);
    }
  }

  private onOnline = () => {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.connect();
    }
  };

  private onVisible = () => {
    // Background tabs get throttled timers; re-measure the clock the moment we're back.
    if (document.visibilityState === 'visible') this.burst();
  };

  private scheduleReconnect() {
    useRoom.setState({ conn: 'reconnecting' });
    const base = Math.min(5000, 250 * 2 ** this.attempts++);
    const delay = base / 2 + Math.random() * (base / 2);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private handle(msg: ServerMsg, recvAt: number) {
    const store = useRoom.getState();
    switch (msg.t) {
      case 'welcome':
        this.seq = msg.seq;
        tokenStore.set(this.code, msg.token);
        store.applySnapshot(msg.you, msg.snapshot, msg.chaosEnabled);
        useRoom.setState({ conn: 'connected' });
        if (!msg.resumed && !this.connectedAt) {
          // Late joiner: remember where the film was so we can offer "what you missed".
          const p = msg.snapshot.playback;
          const pos = p.media ? expectedPosition(p, msg.serverTime, p.media.duration) : 0;
          if (p.media && pos > 45) useRoom.setState({ catchup: { joinedAt: Date.now(), mediaId: p.media.id, position: pos } });
        }
        if (msg.resumed && this.connectedAt) store.toast('Reconnected — you kept your seat', 'success', '🔌');
        this.connectedAt = Date.now();
        this.flushOutbox();
        break;
      case 'resumed':
        // The missed events follow, each with its own seq; this.seq advances as they apply.
        useRoom.setState({ conn: 'connected' });
        store.toast(`Reconnected — caught up on ${msg.replayed} missed update${msg.replayed === 1 ? '' : 's'}`, 'success', '🔌');
        this.flushOutbox();
        break;
      case 'ev':
        if (msg.seq <= this.seq) return; // already applied (replay overlap)
        this.seq = msg.seq;
        store.applyEvent(msg.ev);
        break;
      case 'pong': {
        this.lastPong = performance.now();
        const c3 = performance.timeOrigin + performance.now();
        this.clock.add(clockSample(msg.c0, msg.s1, msg.s2, c3));
        useRoom.setState({ clock: { rtt: this.clock.rtt, offset: this.clock.offset, jitter: this.clock.jitter, synced: this.clock.synced } });
        break;
      }
      case 'reactions':
        store.addReactions(msg.items);
        break;
      case 'heat':
        useRoom.setState((s) => ({ heatmap: { ...s.heatmap, [msg.mediaId]: msg.bins } }));
        break;
      case 'typing':
        useRoom.setState((s) => ({ typing: { ...s.typing, [msg.memberId]: Date.now() } }));
        break;
      case 'telemetry':
        store.setTelemetry(msg.members, msg.latency);
        break;
      case 'myPick':
        useRoom.setState({ myPick: msg.swipes });
        break;
      case 'hover':
        useRoom.setState((s) => {
          const hovers = { ...s.hovers };
          if (msg.time == null) delete hovers[msg.memberId];
          else hovers[msg.memberId] = { time: msg.time, at: Date.now() };
          return { hovers };
        });
        break;
      case 'stats':
        store.setStats(msg.stats);
        break;
      case 'speaking':
        useRoom.setState((s) => ({ speaking: { ...s.speaking, [msg.memberId]: msg.on } }));
        break;
      case 'error':
        if (msg.code === 'passcode') {
          useRoom.setState({ needPasscode: msg.message, conn: 'closed' });
          this.close();
        } else if (msg.fatal) {
          useRoom.setState({ fatal: { code: msg.code, message: msg.message }, conn: 'closed' });
          this.close();
        } else store.toast(msg.message, 'warn');
        break;
    }
    for (const l of this.listeners) l(msg, recvAt);
  }

  private burst() {
    for (let i = 0; i < 8; i++) window.setTimeout(() => this.ping(), i * 60);
  }

  private ping() {
    this.rawSend({ t: 'ping', c0: performance.timeOrigin + performance.now() });
  }

  private rawSend(msg: ClientMsg): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  /** Send now; idempotent message types are queued while offline and replayed on reconnect. */
  send(msg: ClientMsg): boolean {
    const ok = useRoom.getState().conn === 'connected' && this.rawSend(msg);
    if (!ok && QUEUEABLE.has(msg.t)) this.outbox.push(msg);
    return ok;
  }

  private flushOutbox() {
    const queued = this.outbox.splice(0);
    for (const m of queued) this.rawSend(m);
  }

  get pendingCount() {
    return this.outbox.length;
  }

  updateIdentity(i: Identity) {
    this.identity = i;
    this.send({ t: 'profile', ...i });
  }

  /** Testing hook for Chaos mode: drop our own socket. */
  dropConnection() {
    this.ws?.close(4101, 'manual drop');
  }

  leave() {
    this.rawSend({ t: 'leave' });
    this.close();
  }

  close() {
    this.closed = true;
    this.timers.forEach(clearInterval);
    this.timers = [];
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    window.removeEventListener('online', this.onOnline);
    document.removeEventListener('visibilitychange', this.onVisible);
    this.ws?.close(1000, 'bye');
    this.ws = null;
  }
}
