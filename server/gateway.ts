// WebSocket gateway: handshake, validation, rate limiting, liveness, clock pings
// and the Chaos-mode network impairment layer.
import type { IncomingMessage, Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { ClientMsgSchema, PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from '../shared/protocol';
import { DelayQueue } from '../shared/delay-queue';
import type { ChaosConfig } from '../shared/types';
import { Bucket, serverNow } from './clock';
import type { Conn, MemberRec, Room } from './room';
import type { RoomManager } from './rooms';

/**
 * Wraps a socket. With chaos set, every frame in BOTH directions is delayed by
 * lag/2 + U(0, jitter) while preserving order — symmetric, like a real slow
 * link, so clock-offset estimation stays unbiased and drift correction is what
 * gets exercised.
 */
class ChaosConn implements Conn {
  chaos: ChaosConfig | null = null;
  private out = new DelayQueue();
  private in = new DelayQueue();
  constructor(private readonly ws: WebSocket) {}

  private delay(): number {
    return this.chaos ? this.chaos.lagMs / 2 + Math.random() * this.chaos.jitterMs : 0;
  }

  send(data: string) {
    this.out.push(this.delay(), () => {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
    });
  }

  deliver(fn: () => void) {
    this.in.push(this.delay(), fn);
  }

  close(code: number, reason: string) {
    try {
      this.ws.close(code, reason);
    } catch {
      this.ws.terminate();
    }
  }
}

export function attachGateway(server: Server, rooms: RoomManager) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  const alive = new WeakMap<WebSocket, boolean>();

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    if (!req.url?.startsWith('/ws')) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws));
  });

  function onConnection(ws: WebSocket) {
    const conn = new ChaosConn(ws);
    const bucket = new Bucket(100, 240); // room for the ~30 Hz laser pointer on top of pings & reports
    let strikes = 0;
    let room: Room | null = null;
    let member: MemberRec | null = null;
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
    const helloTimer = setTimeout(() => !member && conn.close(4000, 'No hello within 10 s'), 10_000);
    const sendNow = (msg: ServerMsg) => conn.send(JSON.stringify(msg));

    ws.on('message', (raw) => {
      if (!bucket.take()) {
        if (++strikes > 200) conn.close(4008, 'Rate limit exceeded');
        return;
      }
      let data: unknown;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return sendNow({ t: 'error', code: 'bad-json', message: 'Malformed message' });
      }
      const parsed = ClientMsgSchema.safeParse(data);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return sendNow({ t: 'error', code: 'bad-message', message: `${issue?.path.join('.') || 'message'}: ${issue?.message ?? 'invalid'}` });
      }
      conn.deliver(() => handle(parsed.data));
    });

    function handle(msg: ClientMsg) {
      if (msg.t === 'ping') {
        const s1 = serverNow();
        return sendNow({ t: 'pong', c0: msg.c0, s1, s2: serverNow() });
      }
      if (msg.t === 'hello') {
        if (member) return;
        if (msg.v !== PROTOCOL_VERSION) {
          sendNow({ t: 'error', code: 'version', message: 'Marquee was updated — please refresh the page.', fatal: true });
          return conn.close(4005, 'protocol version');
        }
        room = rooms.get(msg.room) ?? null;
        if (!room) {
          sendNow({ t: 'error', code: 'no-room', message: 'That room does not exist (or expired).', fatal: true });
          return conn.close(4004, 'no such room');
        }
        const r = room.join(msg, conn);
        if (!r.ok) {
          sendNow({ t: 'error', code: r.code, message: r.message, fatal: r.code !== 'passcode' });
          return conn.close(4006, r.code);
        }
        member = r.member;
        clearTimeout(helloTimer);
        return;
      }
      if (!room || !member) return sendNow({ t: 'error', code: 'no-hello', message: 'Say hello first' });
      try {
        room.handle(member, msg);
      } catch (e) {
        console.error(`[room ${room.code}] handler error for ${msg.t}`, e);
        sendNow({ t: 'error', code: 'internal', message: 'Something went wrong handling that' });
      }
    }

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (room && member) room.detach(member, conn, false);
    });
    ws.on('error', () => ws.terminate());
  }

  // Liveness: browsers answer protocol pings automatically; 2 missed ⇒ dead socket.
  const hb = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, 7000);
  wss.on('close', () => clearInterval(hb));
  return wss;
}
