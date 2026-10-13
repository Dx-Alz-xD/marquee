// npm run bench [-- --quick] [-- --url http://host:port]
//
// Spins up a fresh Marquee server (or targets --url), then runs scenarios with
// headless bots (tools/bot.ts) that use the same sync code as the browser.
// Writes bench-results/latest.json and the results table in docs/PERFORMANCE.md.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { percentile } from '../shared/sync';
import { Bot, NET, type NetProfile } from './bot';

const args = process.argv.slice(2);
const QUICK = args.includes('--quick');
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const want = (name: string) => !ONLY || name.startsWith(ONLY);
const urlArg = args[args.indexOf('--url') + 1];
const PORT = 3199;
const BASE = args.includes('--url') ? urlArg : `http://127.0.0.1:${PORT}`;
const WS = BASE.replace(/^http/, 'ws') + '/ws';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MEDIA = { kind: 'file' as const, title: 'Bench reel', url: 'https://example.com/bench.mp4', duration: 3600 };

interface Result {
  scenario: string;
  users: number;
  rooms: number;
  network: string;
  commands: number;
  samples: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  driftP50: number | null;
  driftP95: number | null;
  driftP99: number | null;
  extra?: Record<string, unknown>;
  pass: boolean;
}

function pct(xs: number[], p: number) {
  const s = [...xs].sort((a, b) => a - b);
  const v = percentile(s, p);
  return v == null ? null : Math.round(v * 10) / 10;
}

async function startServer(): Promise<ChildProcess | null> {
  if (args.includes('--url')) return null;
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env: { ...process.env, MARQUEE_PORT: String(PORT), ROOM_CAP: '500', CHAOS: '1', TMDB_API_KEY: '', PERSIST: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr?.on('data', (d) => process.stderr.write(`[server] ${d}`));
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/info`);
      if (r.ok) return child;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('server did not start');
}

async function createRoom(): Promise<string> {
  const r = await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'bench', controlMode: 'everyone', syncPolicy: 'relaxed' }) });
  return ((await r.json()) as { code: string }).code;
}

/** Server-side propagation samples (raw click time → applied, server clock) for the given rooms. */
async function serverSamples(codes: string[]): Promise<number[]> {
  const m = (await (await fetch(`${BASE}/metrics?raw=1`)).json()) as { rooms: { code: string; samples?: number[] }[] };
  return m.rooms.filter((r) => codes.includes(r.code)).flatMap((r) => r.samples ?? []);
}

/** One room, N bots, a driver issuing random play/pause/seek. */
/** lanTarget=false: the ≤250 ms propagation spec is for local networks; WAN runs are informational for latency. */
async function scenario(name: string, users: number, net: NetProfile, netName: string, durationMs: number, rooms = 1, lanTarget = true): Promise<Result> {
  process.stdout.write(`▶ ${name} (${rooms}×${users} users, ${netName}) … `);
  const roomBots: Bot[][] = [];
  const codes: string[] = [];
  for (let r = 0; r < rooms; r++) {
    const code = await createRoom();
    codes.push(code);
    const bots: Bot[] = [];
    for (let i = 0; i < users; i++) {
      const b = new Bot(WS, code, `bot${i}`, net);
      bots.push(b);
    }
    // join in small waves like real people
    for (const b of bots) {
      await b.connect();
      if (bots.length > 20) await sleep(5);
    }
    await sleep(800);
    bots[0].send({ t: 'pl', op: 'add', media: MEDIA });
    await sleep(500);
    bots[0].command('play');
    roomBots.push(bots);
  }
  await sleep(3000);

  let commands = 0;
  const t0 = performance.now();
  const drivers = roomBots.map(async (bots) => {
    while (performance.now() - t0 < durationMs) {
      const driver = bots[Math.floor(Math.random() * Math.min(3, bots.length))];
      const p = driver.state;
      const r = Math.random();
      if (p?.status === 'paused') driver.command('play');
      else if (r < 0.45) driver.command('pause');
      else driver.command('seek', Math.random() * 3000);
      commands++;
      // leave room for the steady-state drift sampling between commands
      await sleep(rand(2500, 5000));
      if (driver.state?.status === 'paused') {
        driver.command('play');
        commands++;
        await sleep(rand(4000, 6000));
      }
    }
  });
  await Promise.all(drivers);
  await sleep(1500);

  const all = roomBots.flat();
  // Server-measured propagation (raw click time on the initiator → applied on each receiver, server clock).
  const totals = await serverSamples(codes);
  const drift = all.flatMap((b) => b.stats.drift);
  // Convergence: in every room, all bots end on the same playback version.
  const converged = roomBots.every((bots) => new Set(bots.map((b) => b.state?.version)).size === 1);
  all.forEach((b) => b.close());
  const p95 = pct(totals, 95);
  const d95 = pct(drift, 95);
  const res: Result = {
    scenario: name,
    users,
    rooms,
    network: netName,
    commands,
    samples: totals.length,
    p50: pct(totals, 50),
    p95,
    p99: pct(totals, 99),
    max: pct(totals, 100),
    driftP50: pct(drift, 50),
    driftP95: d95,
    driftP99: pct(drift, 99),
    extra: { converged, errors: all.reduce((a, b) => a + b.stats.errors.length, 0) },
    pass: (!lanTarget || (p95 ?? 0) <= 250) && (d95 ?? 0) <= 500 && converged,
  };
  console.log(`p95 ${res.p95} ms · drift p95 ${res.driftP95} ms · n=${res.samples} ${res.pass ? '✓' : '✗'}`);
  return res;
}

function rand(a: number, b: number) {
  return a + Math.random() * (b - a);
}

/** Everyone smashes pause/seek inside the same 30 ms window. */
async function concurrency(): Promise<Result> {
  process.stdout.write('▶ concurrent-actions (10 users, simultaneous commands) … ');
  const code = await createRoom();
  const bots = Array.from({ length: 10 }, (_, i) => new Bot(WS, code, `c${i}`, NET.wifi));
  for (const b of bots) await b.connect();
  await sleep(500);
  bots[0].send({ t: 'pl', op: 'add', media: MEDIA });
  await sleep(400);
  bots[0].command('play');
  await sleep(2500);
  let rounds = 0;
  let convergedRounds = 0;
  for (let r = 0; r < 12; r++) {
    const kind = r % 3 === 0 ? 'pause' : 'seek';
    await Promise.all(
      bots.map(async (b) => {
        await sleep(Math.random() * 30);
        b.command(kind as 'pause' | 'seek', 100 + Math.random() * 500);
      }),
    );
    await sleep(1500);
    rounds++;
    const versions = new Set(bots.map((b) => b.state?.version));
    const positions = bots.map((b) => b.state!.position);
    if (versions.size === 1 && Math.max(...positions) - Math.min(...positions) < 1e-6) convergedRounds++;
    if (bots[0].state?.status === 'paused') bots[0].command('play');
    await sleep(1200);
  }
  bots.forEach((b) => b.close());
  const pass = convergedRounds === rounds;
  console.log(`${convergedRounds}/${rounds} rounds converged to one identical state ${pass ? '✓' : '✗'}`);
  return {
    scenario: 'concurrent-actions',
    users: 10,
    rooms: 1,
    network: 'wifi',
    commands: rounds * 10,
    samples: rounds,
    p50: null,
    p95: null,
    p99: null,
    max: null,
    driftP50: null,
    driftP95: null,
    driftP99: null,
    extra: { rounds, convergedRounds },
    pass,
  };
}

/** Flaky connections: bots drop and resume while chatting; check no lost/duplicate messages and re-sync. */
async function reconnectStorm(): Promise<Result> {
  process.stdout.write('▶ reconnect-storm (10 users, random drops while chatting) … ');
  const code = await createRoom();
  const bots = Array.from({ length: 10 }, (_, i) => new Bot(WS, code, `r${i}`, NET.wifi));
  for (const b of bots) await b.connect();
  await sleep(500);
  bots[0].send({ t: 'pl', op: 'add', media: MEDIA });
  await sleep(400);
  bots[0].command('play');
  await sleep(2000);
  const sent: string[] = [];
  let drops = 0;
  const end = performance.now() + (QUICK ? 15000 : 30000);
  await Promise.all(
    bots.map(async (b, i) => {
      while (performance.now() < end) {
        await sleep(rand(800, 2000));
        sent.push(b.chat(`hello from ${i}`));
        if (Math.random() < 0.25) {
          drops++;
          await b.drop(rand(200, 3000));
        }
      }
    }),
  );
  bots[0].command('seek', 1234);
  await sleep(4000);
  // every bot must have seen every message exactly once
  let missing = 0;
  let dupes = 0;
  for (const b of bots)
    for (const id of sent) {
      const n = b.stats.chatSeen.get(id) ?? -1;
      if (n === -1) missing++;
      if (n > 1) dupes++;
    }
  const versions = new Set(bots.map((b) => b.state?.version));
  const drift = bots.map((b) => Math.abs(b.currentDrift() ?? 0));
  const resumes = bots.reduce((a, b) => a + b.stats.resumes, 0);
  const welcomes = bots.reduce((a, b) => a + b.stats.welcomes, 0) - bots.length;
  bots.forEach((b) => b.close());
  const pass = dupes === 0 && versions.size === 1 && Math.max(...drift) < 500;
  console.log(`${drops} drops · ${resumes} replay-resumes · ${welcomes} snapshot-resumes · ${missing} missing · ${dupes} dupes · max drift after ${Math.round(Math.max(...drift))} ms ${pass ? '✓' : '✗'}`);
  return {
    scenario: 'reconnect-storm',
    users: 10,
    rooms: 1,
    network: 'wifi',
    commands: sent.length,
    samples: drops,
    p50: null,
    p95: null,
    p99: null,
    max: null,
    driftP50: null,
    driftP95: Math.round(Math.max(...drift)),
    driftP99: null,
    extra: { drops, resumes, snapshotResumes: welcomes, messages: sent.length, missing, dupes, converged: versions.size === 1 },
    pass,
  };
}

async function main() {
  const server = await startServer();
  const results: Result[] = [];
  const D = QUICK ? 15000 : 40000;
  try {
    const plan: [string, () => Promise<Result>][] = [
      ['lan-10', () => scenario('lan-10', 10, NET.lan, 'LAN (localhost)', D)],
      ['wifi-10', () => scenario('wifi-10', 10, NET.wifi, 'Wi-Fi (8 ms ±12)', D)],
      ['wifi-25', () => scenario('wifi-25', 25, NET.wifi, 'Wi-Fi (8 ms ±12)', D)],
      ['wifi-50', () => scenario('wifi-50', 50, NET.wifi, 'Wi-Fi (8 ms ±12)', D)],
      ['multi-room', () => scenario(`multi-room-${QUICK ? 5 : 20}x10`, 10, NET.wifi, 'Wi-Fi (8 ms ±12)', D, QUICK ? 5 : 20)],
      ['wan-10', () => scenario('wan-10', 10, NET.wan, 'Internet (60 ms ±25)', D, 1, false)],
      ['bad-10', () => scenario('bad-10', 10, NET.bad, 'Bad link (180 ms ±90, 2% spikes)', D, 1, false)],
      ['concurrent', () => concurrency()],
      ['reconnect', () => reconnectStorm()],
    ];
    for (const [name, run] of plan) if (want(name)) results.push(await run());
  } finally {
    server?.kill();
    await sleep(400);
  }

  const env = {
    date: new Date().toISOString(),
    node: process.version,
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    cpu: os.cpus()[0]?.model ?? 'unknown',
    cores: os.cpus().length,
    memGB: Math.round(os.totalmem() / 1024 ** 3),
    mode: QUICK ? 'quick' : 'full',
  };
  mkdirSync(new URL('../bench-results/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../bench-results/latest.json', import.meta.url), JSON.stringify({ env, results }, null, 2));

  const fmt = (v: number | null | undefined) => (v == null ? '—' : String(v));
  const table = [
    `_Run ${env.date} · ${env.cpu} (${env.cores} cores, ${env.memGB} GB) · ${env.os} · Node ${env.node} · ${env.mode} run_`,
    '',
    '| Scenario | Users | Network | Cmds | Samples | Propagation p50 / p95 / p99 / max (ms) | Drift p50 / p95 / p99 (ms) | Result |',
    '|---|---|---|---|---|---|---|---|',
    ...results.map(
      (r) =>
        `| ${r.scenario} | ${r.rooms > 1 ? `${r.rooms}×${r.users}` : r.users} | ${r.network} | ${r.commands} | ${r.samples} | ${[r.p50, r.p95, r.p99, r.max].map(fmt).join(' / ')} | ${[r.driftP50, r.driftP95, r.driftP99].map(fmt).join(' / ')} | ${r.pass ? '✅' : '❌'}${r.extra ? ` ${Object.entries(r.extra).map(([k, v]) => `${k}=${v}`).join(', ')}` : ''} |`,
    ),
  ].join('\n');
  console.log(`\n${table}\n`);
  const docUrl = new URL('../docs/PERFORMANCE.md', import.meta.url);
  try {
    const doc = readFileSync(docUrl, 'utf8');
    const next = doc.replace(/<!-- BENCH:START -->[\s\S]*<!-- BENCH:END -->/, `<!-- BENCH:START -->\n${table}\n<!-- BENCH:END -->`);
    writeFileSync(docUrl, next);
    console.log('Updated docs/PERFORMANCE.md');
  } catch {
    /* doc not present */
  }
  process.exit(results.every((r) => r.pass) ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
