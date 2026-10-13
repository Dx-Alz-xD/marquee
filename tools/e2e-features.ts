// npm run e2e [-- --url http://localhost:3000]
// End-to-end smoke test of the social features against a live server, using two
// headless clients: synced speed, film-end stats (Wrap trigger), ratings verdict,
// voice signalling relay, laser pointer and ghost-scrub relay.
import type { ServerMsg } from '../shared/protocol';
import { Bot } from './bot';

const args = process.argv.slice(2);
const BASE = args.includes('--url') ? args[args.indexOf('--url') + 1] : 'http://localhost:3000';
const WS = BASE.replace(/^http/, 'ws') + '/ws';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const results: [string, boolean, string?][] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  results.push([name, ok, detail]);
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

function inbox(bot: Bot) {
  const msgs: ServerMsg[] = [];
  bot.ws!.on('message', (raw) => msgs.push(JSON.parse(raw.toString())));
  return {
    msgs,
    waitFor: async <T extends ServerMsg>(pred: (m: ServerMsg) => m is T, ms = 8000): Promise<T | null> => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const hit = msgs.find(pred);
        if (hit) return hit as T;
        await sleep(50);
      }
      return null;
    },
  };
}

async function main() {
  const r = await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'e2e', syncPolicy: 'relaxed' }) });
  const { code } = (await r.json()) as { code: string };
  const a = new Bot(WS, code, 'Ana');
  const b = new Bot(WS, code, 'Ben');
  await a.connect();
  await b.connect();
  const ia = inbox(a);
  const ib = inbox(b);

  // ── Speed ──
  a.send({ t: 'pl', op: 'add', media: { kind: 'file', title: 'Short', url: 'https://example.com/short.mp4', duration: 6 } });
  await sleep(300);
  a.command('play');
  await sleep(300);
  a.send({ t: 'speed', rate: 1.5 });
  const sp = await ib.waitFor((m): m is Extract<ServerMsg, { t: 'ev' }> => m.t === 'ev' && m.ev.e === 'playback' && m.ev.playback.rate === 1.5);
  check('synced speed reaches the other client', !!sp, sp && sp.ev.e === 'playback' ? `rate ${sp.ev.playback.rate}×` : 'no rate change seen');

  // ── Reactions + chat feed the stats ──
  a.send({ t: 'react', emoji: '🔥', mediaTime: 1 });
  b.send({ t: 'react', emoji: '🔥', mediaTime: 1.5 });
  b.send({ t: 'react', emoji: '😂', mediaTime: 3 });
  b.chat('this is great');

  // ── Hover + pointer relay ──
  a.send({ t: 'hover', time: 2.5 });
  a.send({ t: 'pointer', x: 0.4, y: 0.6, mode: 'laser', end: false });
  const hv = await ib.waitFor((m): m is Extract<ServerMsg, { t: 'hover' }> => m.t === 'hover');
  const pt = await ib.waitFor((m): m is Extract<ServerMsg, { t: 'pointer' }> => m.t === 'pointer');
  check('ghost-scrub hover relayed', !!hv && hv.time === 2.5);
  check('laser pointer relayed', !!pt && pt.x === 0.4 && pt.y === 0.6);
  check('sender does not get its own pointer back', !ia.msgs.some((m) => m.t === 'pointer'));

  // ── Film ends → stats with endedAt (this is what rolls the Wrap) ──
  const end = await ib.waitFor((m): m is Extract<ServerMsg, { t: 'stats' }> => m.t === 'stats' && !!m.stats.endedAt, 12_000);
  check('film end broadcasts final stats (Wrap trigger)', !!end, end ? `moments=${Object.keys(end.stats.moments).length}, chat=${JSON.stringify(end.stats.chat)}` : 'timed out');
  if (end) {
    const s = end.stats;
    check('top-moment bins recorded', (s.moments[0]?.['🔥'] ?? 0) === 2);
    check('per-person reactions recorded', s.reactions[b.you!]?.['😂'] === 1);
    // ── Ratings → verdict ──
    a.send({ t: 'rating', mediaId: s.mediaId, stars: 5 });
    b.send({ t: 'rating', mediaId: s.mediaId, stars: 4 });
    const verdict = await ia.waitFor((m): m is Extract<ServerMsg, { t: 'ev' }> => m.t === 'ev' && m.ev.e === 'chat' && m.ev.message.text.includes('Room verdict'));
    check('room verdict posted when everyone rated', !!verdict, verdict && verdict.ev.e === 'chat' ? verdict.ev.message.text : undefined);
  }

  // ── Voice signalling relay ──
  a.send({ t: 'voice', on: true, mic: true });
  b.send({ t: 'voice', on: true, mic: false });
  await sleep(300);
  a.send({ t: 'rtc', to: b.you!, data: { type: 'offer', sdp: 'v=0 test' } });
  const offer = await ib.waitFor((m): m is Extract<ServerMsg, { t: 'rtc' }> => m.t === 'rtc');
  check('WebRTC offer relayed to the addressed peer', !!offer && offer.from === a.you && offer.data.type === 'offer');
  a.send({ t: 'speaking', on: true });
  const spk = await ib.waitFor((m): m is Extract<ServerMsg, { t: 'speaking' }> => m.t === 'speaking' && m.on);
  check('speaking indicator relayed (drives ducking)', !!spk);

  a.close();
  b.close();
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  await sleep(200);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
