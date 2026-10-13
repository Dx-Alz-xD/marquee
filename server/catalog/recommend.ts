// Content-based GROUP recommender.
//
// Each movie → sparse feature vector (genres, keywords, director, cast, decade,
// language). Each member → taste vector (Σ liked − 0.8·Σ disliked). For a room we
// score every candidate per member and aggregate with "average without misery":
// a movie anyone clearly dislikes is dropped, the rest are ranked by mean taste
// match blended with a quality prior. Explanations name the member and the liked
// movie that drove the match ("Because Ana liked Arrival").
import type { Movie } from '../../shared/types';

export type Vec = Map<string, number>;

export interface Taste {
  memberId: string;
  name: string;
  likes: string[];
  dislikes: string[];
}

export interface Rec {
  movie: Movie;
  score: number;
  reason: string | null;
}

const norm = (s: string) => s.toLowerCase().trim();

export function featureVec(m: Movie): Vec {
  const v: Vec = new Map();
  const add = (k: string, w: number) => v.set(k, (v.get(k) ?? 0) + w);
  for (const g of m.genres) add(`g:${norm(g)}`, 1);
  for (const k of m.keywords.slice(0, 12)) add(`k:${norm(k)}`, 0.55);
  if (m.director) add(`d:${norm(m.director)}`, 0.9);
  for (const c of m.cast.slice(0, 4)) add(`c:${norm(c)}`, 0.45);
  if (m.year) add(`dec:${Math.floor(m.year / 10) * 10}`, 0.35);
  if (m.language && m.language !== 'en') add(`lang:${m.language}`, 0.3);
  for (const mood of m.moods ?? []) add(`m:${mood}`, 0.4);
  return normalize(v);
}

export function normalize(v: Vec): Vec {
  let n = 0;
  for (const x of v.values()) n += x * x;
  n = Math.sqrt(n) || 1;
  const out: Vec = new Map();
  for (const [k, x] of v) out.set(k, x / n);
  return out;
}

export function cosine(a: Vec, b: Vec): number {
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  let s = 0;
  for (const [k, x] of small) {
    const y = big.get(k);
    if (y) s += x * y;
  }
  return s;
}

export function profile(likes: Vec[], dislikes: Vec[]): Vec | null {
  if (!likes.length && !dislikes.length) return null;
  const v: Vec = new Map();
  for (const l of likes) for (const [k, x] of l) v.set(k, (v.get(k) ?? 0) + x);
  for (const d of dislikes) for (const [k, x] of d) v.set(k, (v.get(k) ?? 0) - 0.8 * x);
  return normalize(v);
}

export interface RecContext {
  movies: Movie[];
  get(id: string): Movie | undefined;
  vec(id: string): Vec;
}

export function qualityPrior(m: Movie, maxVotes: number): number {
  const rating = m.rating ?? 6.2;
  const r = Math.max(-1, Math.min(1, (rating - 6.3) / 2.2));
  const pop = maxVotes > 0 ? Math.log1p(m.votes) / Math.log1p(maxVotes) : 0.3;
  return 0.6 * r + 0.4 * pop;
}

export function groupRecommend(
  ctx: RecContext,
  tastes: Taste[],
  opts: { exclude?: Set<string>; limit?: number; pool?: Movie[]; diversity?: number } = {},
): Rec[] {
  const limit = opts.limit ?? 20;
  const exclude = opts.exclude ?? new Set<string>();
  const pool = (opts.pool ?? ctx.movies).filter((m) => !exclude.has(m.id) && (m.trailer || m.playable));
  const maxVotes = pool.reduce((a, m) => Math.max(a, m.votes), 0);

  const profiles = tastes
    .map((t) => ({
      t,
      p: profile(
        t.likes.map((id) => ctx.vec(id)).filter((v) => v.size),
        t.dislikes.map((id) => ctx.vec(id)).filter((v) => v.size),
      ),
      seen: new Set([...t.likes, ...t.dislikes]),
      disliked: new Set(t.dislikes),
    }))
    .filter((x) => x.p);

  const scored: { m: Movie; score: number; reason: string | null }[] = [];
  for (const m of pool) {
    if (profiles.some((x) => x.seen.has(m.id))) continue;
    const q = qualityPrior(m, maxVotes);
    if (!profiles.length) {
      scored.push({ m, score: q + Math.random() * 0.05, reason: null });
      continue;
    }
    const v = ctx.vec(m.id);
    const per = profiles.map((x) => ({ x, s: cosine(x.p!, v) }));
    // Least-misery guard: nobody gets a movie that sits squarely in their dislikes.
    if (per.some(({ s }) => s < -0.12)) continue;
    const mean = per.reduce((a, b) => a + b.s, 0) / per.length;
    const min = Math.min(...per.map((p) => p.s));
    const score = 0.65 * mean + 0.1 * min + 0.25 * q;
    scored.push({ m, score, reason: explain(ctx, m, per) });
  }

  scored.sort((a, b) => b.score - a.score);
  // Greedy MMR for variety: penalise near-duplicates of already chosen titles.
  const chosen: typeof scored = [];
  const lambda = opts.diversity ?? 0.35;
  const head = scored.slice(0, Math.max(limit * 8, 120));
  while (chosen.length < limit && head.length) {
    let bestI = 0;
    let bestS = -Infinity;
    for (let i = 0; i < head.length; i++) {
      const sim = chosen.length ? Math.max(...chosen.map((c) => cosine(ctx.vec(c.m.id), ctx.vec(head[i].m.id)))) : 0;
      const s = head[i].score - lambda * sim;
      if (s > bestS) {
        bestS = s;
        bestI = i;
      }
    }
    chosen.push(head.splice(bestI, 1)[0]);
  }
  return chosen.map((c) => ({ movie: c.m, score: Math.round(c.score * 1000) / 1000, reason: c.reason }));
}

function explain(
  ctx: RecContext,
  m: Movie,
  per: { x: { t: Taste; p: Vec | null }; s: number }[],
): string | null {
  const v = ctx.vec(m.id);
  const drivers = per
    .filter((p) => p.s > 0.18)
    .sort((a, b) => b.s - a.s)
    .slice(0, 2)
    .map((p) => {
      let best: { title: string; sim: number } | null = null;
      for (const id of p.x.t.likes) {
        const lm = ctx.get(id);
        if (!lm) continue;
        const sim = cosine(ctx.vec(id), v);
        if (!best || sim > best.sim) best = { title: lm.title, sim };
      }
      return best ? `${p.x.t.name} liked ${best.title}` : null;
    })
    .filter(Boolean);
  if (drivers.length) return `Because ${drivers.join(' and ')}`;
  if (per.length > 1 && per.every((p) => p.s > 0.05)) return 'A safe bet for everyone here';
  return null;
}
