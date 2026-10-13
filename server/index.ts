// Marquee server: HTTP API + static SPA + WebSocket gateway, one process.
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { basename, join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { normalizeRoomCode, uid } from '../shared/util';
import { Catalog, type SearchParams } from './catalog/catalog';
import { cosine } from './catalog/recommend';
import { seedTmdb } from './catalog/tmdb';
import { attachGateway } from './gateway';
import { globalReport, stats } from './metrics';
import { RoomManager } from './rooms';
import { startTunnel, type TunnelHandle } from './tunnel';

try {
  process.loadEnvFile();
} catch {
  /* no .env file — fine */
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');
const UPLOADS = join(ROOT, 'uploads');
// --dev: the API always sits on :3000 behind Vite (MARQUEE_PORT overrides), whatever PORT the shell exported.
const DEV = process.argv.includes('--dev');
const PORT = Number(process.env.MARQUEE_PORT ?? (DEV ? 3000 : process.env.PORT ?? 3000));
const SHARE = process.argv.includes('--share') || process.env.SHARE === '1';
const CHAOS = process.env.CHAOS !== '0';
const CAP = Math.max(2, Number(process.env.ROOM_CAP ?? 50));
const TMDB_KEY = process.env.TMDB_API_KEY?.trim() ?? '';
mkdirSync(UPLOADS, { recursive: true });

const catalog = new Catalog();
const rooms = new RoomManager({ catalog, chaosEnabled: CHAOS, cap: CAP });
const tmdbState: { configured: boolean; seeding: boolean; error: string | null } = { configured: !!TMDB_KEY, seeding: false, error: null };
let tunnel: TunnelHandle | null = null;

if (TMDB_KEY && !existsSync(join(ROOT, 'data', 'catalog.tmdb.json'))) {
  tmdbState.seeding = true;
  console.log('[tmdb] key found, building the movie catalog in the background (~1 min)…');
  seedTmdb(TMDB_KEY)
    .then(() => catalog.load())
    .catch((e) => {
      tmdbState.error = (e as Error).message;
      console.error('[tmdb]', tmdbState.error);
    })
    .finally(() => (tmdbState.seeding = false));
}

function lanUrls(port: number): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces()))
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) out.push(`http://${i.address}:${port}`);
  // Prefer typical home/office ranges first.
  return out.sort((a, b) => score(b) - score(a));
  function score(u: string) {
    return u.includes('//192.168.') ? 3 : u.includes('//10.') ? 2 : u.includes('//172.') ? 1 : 0;
  }
}

const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });

// Raw streaming uploads (multi-GB files): we take the request stream as-is.
app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

if (existsSync(DIST)) {
  await app.register(fastifyStatic, { root: DIST, prefix: '/', index: ['index.html'] });
}
await app.register(fastifyStatic, { root: UPLOADS, prefix: '/media/', decorateReply: !existsSync(DIST), acceptRanges: true, cacheControl: false });

// ─── Info ────────────────────────────────────────────────────────────────────
app.get('/api/info', async () => ({
  name: 'Marquee',
  lanUrls: lanUrls(PORT),
  port: PORT,
  publicUrl: tunnel?.url ?? null,
  tunnel: tunnel ? tunnel.status : SHARE ? 'starting' : 'off',
  tmdb: { ...tmdbState, seeded: existsSync(join(ROOT, 'data', 'catalog.tmdb.json')) },
  catalog: { total: catalog.size },
  chaos: CHAOS,
  cap: CAP,
}));

// ─── Rooms ───────────────────────────────────────────────────────────────────
app.post<{ Body: { name?: string; controlMode?: 'host' | 'everyone' | 'democracy'; syncPolicy?: 'strict' | 'relaxed'; passcode?: string } }>(
  '/api/rooms',
  async (req) => {
    const b = req.body ?? {};
    const room = rooms.create({
      name: typeof b.name === 'string' ? b.name.slice(0, 60) : undefined,
      controlMode: ['host', 'everyone', 'democracy'].includes(b.controlMode as string) ? b.controlMode : undefined,
      syncPolicy: b.syncPolicy === 'relaxed' ? 'relaxed' : 'strict',
      passcode: typeof b.passcode === 'string' ? b.passcode.slice(0, 64) : undefined,
    });
    return { code: room.code };
  },
);

app.get<{ Params: { code: string } }>('/api/rooms/:code', async (req, reply) => {
  const code = normalizeRoomCode(req.params.code);
  const room = code ? rooms.get(code) : undefined;
  if (!room) return reply.code(404).send({ exists: false });
  return {
    exists: true,
    code: room.code,
    name: room.settings.name,
    online: room.onlineCount,
    hasPasscode: !!room.settings.passcode,
    nowPlaying: room.playback.media?.title ?? null,
    members: [...room.members.values()].filter((m) => m.online).map((m) => ({ name: m.name, avatar: m.avatar, color: m.color })),
  };
});

// ─── Movies ──────────────────────────────────────────────────────────────────
app.get('/api/movies/meta', async () => ({ ...catalog.meta(), tmdb: tmdbState }));

app.get<{ Querystring: Record<string, string | undefined> }>('/api/movies/search', async (req) => {
  const q = req.query;
  const num = (v?: string) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
  const params: SearchParams = {
    q: q.q?.slice(0, 200),
    genres: q.genres ? q.genres.split(',').filter(Boolean) : undefined,
    yearMin: num(q.yearMin),
    yearMax: num(q.yearMax),
    ratingMin: num(q.ratingMin),
    runtimeMax: num(q.runtimeMax),
    runtimeMin: num(q.runtimeMin),
    lang: q.lang || undefined,
    mood: q.mood || undefined,
    playable: q.playable === '1' || q.playable === 'true',
    sort: (q.sort as SearchParams['sort']) || undefined,
    limit: num(q.limit),
    offset: num(q.offset),
  };
  return catalog.search(params);
});

app.get<{ Querystring: { room?: string; minutesLeft?: string } }>('/api/movies/shelves', async (req) => {
  const room = req.query.room ? rooms.get(req.query.room) : undefined;
  const exclude = new Set((room?.playlist ?? []).map((i) => i.media.movieId).filter((x): x is string => !!x));
  const minutesLeft = req.query.minutesLeft ? Number(req.query.minutesLeft) : null;
  return { shelves: catalog.shelves({ tastes: room?.tastes() ?? [], exclude, minutesLeft }), total: catalog.size };
});

app.get<{ Querystring: { ids?: string } }>('/api/movies', async (req) => ({
  movies: (req.query.ids ?? '')
    .split(',')
    .slice(0, 50)
    .map((id) => catalog.get(id))
    .filter(Boolean),
}));

app.get<{ Params: { id: string } }>('/api/movies/:id', async (req, reply) => {
  const movie = catalog.get(req.params.id);
  if (!movie) return reply.code(404).send({ error: 'not found' });
  const v = catalog.vec(movie.id);
  const similar = catalog.movies
    .filter((m) => m.id !== movie.id && (m.trailer || m.playable))
    .map((m) => ({ m, s: cosine(v, catalog.vec(m.id)) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 12)
    .map((x) => x.m);
  return { movie, similar };
});

// ─── Uploads ("stream my file to the room") ──────────────────────────────────
app.post<{ Querystring: { name?: string } }>('/api/upload', async (req, reply) => {
  const len = Number(req.headers['content-length'] ?? 0);
  if (len > 8 * 1024 ** 3) return reply.code(413).send({ error: 'File too large (8 GB max)' });
  const original = basename(String(req.query.name ?? 'video.mp4')).replace(/[^\w.\- ()[\]]+/g, '_').slice(-120) || 'video.mp4';
  const stored = `${uid(8)}-${original}`;
  const dest = join(UPLOADS, stored);
  await pipeline(req.body as Readable, createWriteStream(dest));
  return { url: `/media/${encodeURIComponent(stored)}`, name: original, size: statSync(dest).size };
});

// ─── Metrics ─────────────────────────────────────────────────────────────────
app.get<{ Querystring: { raw?: string } }>('/metrics', async (req) => ({
  ...globalReport(),
  rooms: [...rooms.rooms.values()].map((r) => ({
    code: r.code,
    online: r.onlineCount,
    propagation: stats(r.metrics.latency.values().map((x) => x.total)),
    drift: stats(r.metrics.drift.values()),
    ...(req.query.raw ? { samples: r.metrics.latency.values().map((x) => x.total), driftSamples: r.metrics.drift.values() } : {}),
  })),
}));

// SPA fallback: deep links like /r/ABCDEF render the app.
app.setNotFoundHandler((req, reply) => {
  const path = req.url.split('?')[0];
  const looksLikeFile = /\.[a-z0-9]{1,6}$/i.test(path);
  if (req.method === 'GET' && existsSync(DIST) && !looksLikeFile && !path.startsWith('/api') && !path.startsWith('/media'))
    return reply.sendFile('index.html', DIST);
  reply.code(404).send({ error: 'Not found' });
});

await app.listen({ host: '0.0.0.0', port: PORT });
attachGateway(app.server, rooms);

const lan = lanUrls(PORT);
console.log(`
  🎬  Marquee is running
      Local:    http://localhost:${PORT}
      Network:  ${lan[0] ?? '(no LAN interface found)'}${lan.slice(1).map((u) => `\n                ${u}`).join('')}
      Catalog:  ${catalog.size} movies${TMDB_KEY ? '' : '  (add TMDB_API_KEY to .env for ~1,000 more)'}
      ${existsSync(DIST) ? '' : 'UI:       not built — run `npm run dev` (UI on :5173) or `npm start`'}`);

if (SHARE) {
  startTunnel(PORT)
    .then((t) => {
      tunnel = t;
    })
    .catch((e) => console.error('[share] could not open tunnel:', (e as Error).message));
}

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('\n[marquee] saving rooms and shutting down…');
  rooms.stop();
  tunnel?.stop();
  app.close().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
