// Movie catalog: loading, mood tagging, fuzzy search (MiniSearch) + filters,
// discovery shelves and group recommendations.
import MiniSearch from 'minisearch';
import { existsSync, readFileSync } from 'node:fs';
import type { Movie, MovieHit, Shelf } from '../../shared/types';
import { fold, GENRES, inRange, parseQuery, type ParsedQuery, type QueryFilters } from './query';
import { featureVec, groupRecommend, type RecContext, type Taste, type Vec } from './recommend';

const DATA = new URL('../../data/', import.meta.url);
const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'in', 'on', 'to', 'la', 'le', 'el']);

export interface Mood {
  id: string;
  title: string;
  subtitle: string;
  test: (m: Movie, kw: string) => boolean;
}

const has = (m: Movie, ...gs: string[]) => gs.some((g) => m.genres.includes(g));

export const MOODS: Mood[] = [
  {
    id: 'mind-bending',
    title: 'Mind-bending',
    subtitle: 'Twists, loops and unreliable realities',
    test: (m, kw) =>
      (has(m, 'Science Fiction', 'Mystery', 'Thriller', 'Fantasy') &&
        /time travel|time loop|dream|memory|parallel|alternate|twist|reality|simulation|virtual|identity|mind|surreal|amnesia|multiverse|paradox/.test(kw)) ||
      (has(m, 'Science Fiction') && has(m, 'Mystery')),
  },
  {
    id: 'cozy',
    title: 'Cozy night in',
    subtitle: 'Warm, gentle, blanket-approved',
    test: (m) => (has(m, 'Animation', 'Family') || (has(m, 'Comedy') && has(m, 'Romance'))) && !has(m, 'Horror', 'War', 'Crime', 'Thriller'),
  },
  {
    id: 'edge-of-seat',
    title: 'Edge of your seat',
    subtitle: 'Pulse-raising thrillers and action',
    test: (m) => has(m, 'Thriller') || (has(m, 'Action') && has(m, 'Crime', 'Adventure', 'Science Fiction')),
  },
  {
    id: 'feel-good',
    title: 'Feel-good',
    subtitle: 'Guaranteed to leave the room smiling',
    test: (m) => has(m, 'Comedy', 'Music') && !has(m, 'Horror', 'Thriller', 'War', 'Crime'),
  },
  {
    id: 'epic',
    title: 'Epic journeys',
    subtitle: 'Big worlds, long runtimes, grand stakes',
    test: (m) => (m.runtime ?? 0) >= 150 || (has(m, 'Adventure') && has(m, 'Fantasy', 'Science Fiction')) || has(m, 'War', 'History'),
  },
  {
    id: 'date-night',
    title: 'Date night',
    subtitle: 'Romance, banter, chemistry',
    test: (m) => has(m, 'Romance'),
  },
  {
    id: 'after-dark',
    title: 'After dark',
    subtitle: 'Lights off. Nobody sits alone.',
    test: (m) => has(m, 'Horror'),
  },
];

export class Catalog implements RecContext {
  movies: Movie[] = [];
  private byId = new Map<string, Movie>();
  private vecs = new Map<string, Vec>();
  private index!: MiniSearch<Movie>;
  loadedAt = 0;

  constructor() {
    this.load();
  }

  load(): void {
    const files = ['catalog.tmdb.json', 'catalog.open.json'];
    const seen = new Set<string>();
    const movies: Movie[] = [];
    for (const f of files) {
      const url = new URL(f, DATA);
      if (!existsSync(url)) continue;
      try {
        for (const m of JSON.parse(readFileSync(url, 'utf8')) as Movie[]) {
          const key = `${fold(m.title)}|${m.year}`;
          // Prefer the TMDB record (richer metadata), but keep the free stream from the open catalog.
          if (seen.has(key)) {
            const existing = movies.find((x) => `${fold(x.title)}|${x.year}` === key);
            if (existing && !existing.playable && m.playable) existing.playable = m.playable;
            continue;
          }
          seen.add(key);
          movies.push(m);
        }
      } catch (e) {
        console.warn(`[catalog] failed to read ${f}:`, (e as Error).message);
      }
    }
    for (const m of movies) {
      const kw = `${m.keywords.join(' ')} ${m.overview}`.toLowerCase();
      m.moods = MOODS.filter((mood) => mood.test(m, kw)).map((x) => x.id);
      if (!m.popularity) m.popularity = (m.rating ?? 5) * 2;
    }
    this.movies = movies;
    this.byId = new Map(movies.map((m) => [m.id, m]));
    this.vecs = new Map(movies.map((m) => [m.id, featureVec(m)]));

    const index = new MiniSearch<Movie>({
      fields: ['title', 'director', 'cast', 'keywords', 'genres', 'aliases', 'overview'],
      storeFields: [],
      extractField: (doc, field) => {
        if (field === 'aliases') return aliasesFor(doc);
        const v = (doc as unknown as Record<string, unknown>)[field];
        return Array.isArray(v) ? v.join(' | ') : (v as string) ?? '';
      },
      processTerm: (term) => {
        const t = fold(term);
        return t && !STOP.has(t) ? t : null;
      },
      searchOptions: {
        boost: { title: 6, director: 2.5, cast: 2, keywords: 1.2, genres: 1.2, aliases: 1, overview: 0.35 },
        fuzzy: (term) => (term.length <= 3 ? 0 : term.length <= 6 ? 1 : 2),
        prefix: (term) => term.length >= 2,
      },
    });
    index.addAll(movies);
    this.index = index;
    this.loadedAt = Date.now();
    console.log(`[catalog] ${movies.length} movies (${movies.filter((m) => m.playable).length} free to stream)`);
  }

  get(id: string): Movie | undefined {
    return this.byId.get(id);
  }
  vec(id: string): Vec {
    return this.vecs.get(id) ?? new Map();
  }
  get size(): number {
    return this.movies.length;
  }

  meta() {
    const years = this.movies.map((m) => m.year).filter((y): y is number => !!y);
    const langs = new Map<string, number>();
    for (const m of this.movies) langs.set(m.language, (langs.get(m.language) ?? 0) + 1);
    return {
      genres: GENRES.filter((g) => this.movies.some((m) => m.genres.includes(g))),
      moods: MOODS.map(({ id, title, subtitle }) => ({ id, title, subtitle })),
      languages: [...langs.entries()].sort((a, b) => b[1] - a[1]).map(([code, count]) => ({ code, count })),
      yearMin: years.length ? Math.min(...years) : 1900,
      yearMax: years.length ? Math.max(...years) : new Date().getFullYear(),
      total: this.movies.length,
      playable: this.movies.filter((m) => m.playable).length,
    };
  }

  search(params: SearchParams): SearchResponse {
    const t0 = performance.now();
    const parsed = parseQuery(params.q ?? '', MOODS.map((m) => m.id));
    const f = mergeFilters(parsed.filters, params);
    const pass = (m: Movie) => matches(m, f);

    let hits: MovieHit[];
    if (parsed.text) {
      // AND first (precise), widen to OR if that is too strict.
      const and = this.index.search(parsed.text, { combineWith: 'AND', filter: (r) => pass(this.byId.get(r.id)!) });
      let res = and;
      if (and.length < 8) {
        const ids = new Set(and.map((r) => r.id));
        res = and.concat(this.index.search(parsed.text, { combineWith: 'OR', filter: (r) => !ids.has(r.id) && pass(this.byId.get(r.id)!) }).map((r) => ({ ...r, score: r.score * 0.5 })));
      }
      hits = res.map((r) => {
        const m = this.byId.get(r.id)!;
        // Gentle popularity tie-breaker so the famous "Dune" outranks an obscure one.
        const score = r.score * (1 + Math.log1p(m.votes) / 40);
        return { ...m, score, reason: why(m, r.match as Record<string, string[]>, parsed.text) };
      });
      hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    } else {
      hits = this.movies.filter(pass).map((m) => ({ ...m }));
      hits.sort((a, b) => b.popularity - a.popularity);
    }
    const sort = params.sort ?? 'relevance';
    if (sort === 'rating') hits.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
    if (sort === 'year') hits.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
    if (sort === 'popularity') hits.sort((a, b) => b.popularity - a.popularity);
    if (sort === 'runtime') hits.sort((a, b) => (a.runtime ?? 999) - (b.runtime ?? 999));

    const offset = params.offset ?? 0;
    const limit = Math.min(params.limit ?? 40, 100);
    return {
      results: hits.slice(offset, offset + limit),
      total: hits.length,
      parsed,
      tookMs: Math.round((performance.now() - t0) * 100) / 100,
    };
  }

  recommend(tastes: Taste[], exclude: Set<string>, limit = 20) {
    return groupRecommend(this, tastes, { exclude, limit });
  }

  shelves(opts: { tastes?: Taste[]; exclude?: Set<string>; minutesLeft?: number | null }): Shelf[] {
    const watchable = this.movies.filter((m) => m.trailer || m.playable);
    const top = (xs: Movie[], n = 24) => xs.slice(0, n);
    const byPop = [...watchable].sort((a, b) => b.popularity - a.popularity);
    const shelves: Shelf[] = [];

    const tastes = (opts.tastes ?? []).filter((t) => t.likes.length + t.dislikes.length > 0);
    if (tastes.length) {
      const recs = this.recommend(tastes, opts.exclude ?? new Set(), 20);
      shelves.push({
        id: 'for-room',
        title: 'Picked for this room',
        subtitle: `Blended from ${tastes.map((t) => t.name).join(', ')}'s taste — nobody gets stuck with a dud`,
        movies: recs.map((r) => ({ ...r.movie, score: r.score, reason: r.reason })),
      });
    }
    const free = this.movies.filter((m) => m.playable).sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
    if (free.length) shelves.push({ id: 'free', title: 'Free to watch — full movies', subtitle: 'Public-domain classics & open movies, streamable right now', movies: top(free, 40) });
    const tmdb = byPop.filter((m) => m.source === 'tmdb');
    if (tmdb.length) shelves.push({ id: 'trending', title: 'Trending now', movies: top(tmdb) });
    if (opts.minutesLeft != null && opts.minutesLeft > 70 && opts.minutesLeft < 420) {
      const fits = byPop.filter((m) => m.runtime && m.runtime >= 60 && m.runtime <= opts.minutesLeft! - 10);
      if (fits.length)
        shelves.push({ id: 'before-midnight', title: 'Ends before midnight', subtitle: `Under ${opts.minutesLeft - 10} min — you'll still get some sleep`, movies: top(fits) });
    }
    const rated = [...watchable].filter((m) => m.votes > 2000 || m.source !== 'tmdb').sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
    if (rated.length) shelves.push({ id: 'top-rated', title: 'All-time greats', movies: top(rated) });
    for (const mood of MOODS) {
      const ms = byPop.filter((m) => m.moods?.includes(mood.id));
      if (ms.length >= 4) shelves.push({ id: `mood-${mood.id}`, title: mood.title, subtitle: mood.subtitle, movies: top(ms) });
    }
    const short = byPop.filter((m) => m.runtime && m.runtime <= 100);
    if (short.length >= 4) shelves.push({ id: 'short', title: 'Under 100 minutes', subtitle: 'Short on time, big on movie', movies: top(short) });
    for (const [lo, label] of [
      [1980, 'Totally 80s'],
      [1990, '90s rewind'],
      [2000, 'The 2000s'],
    ] as const) {
      const ms = byPop.filter((m) => m.year && m.year >= lo && m.year < lo + 10);
      if (ms.length >= 6) shelves.push({ id: `decade-${lo}`, title: label, movies: top(ms) });
    }
    return shelves.filter((s) => s.movies.length);
  }
}

export interface SearchParams {
  q?: string;
  genres?: string[];
  yearMin?: number;
  yearMax?: number;
  ratingMin?: number;
  runtimeMax?: number;
  runtimeMin?: number;
  lang?: string;
  mood?: string;
  playable?: boolean;
  sort?: 'relevance' | 'popularity' | 'rating' | 'year' | 'runtime';
  limit?: number;
  offset?: number;
}

export interface SearchResponse {
  results: MovieHit[];
  total: number;
  parsed: ParsedQuery;
  tookMs: number;
}

function mergeFilters(f: QueryFilters, p: SearchParams): QueryFilters {
  const out: QueryFilters = { ...f, genres: [...f.genres, ...(p.genres ?? [])] };
  if (p.yearMin != null || p.yearMax != null) out.year = { min: p.yearMin ?? out.year?.min, max: p.yearMax ?? out.year?.max };
  if (p.ratingMin != null) out.rating = { ...out.rating, min: p.ratingMin };
  if (p.runtimeMax != null || p.runtimeMin != null) out.runtime = { min: p.runtimeMin ?? out.runtime?.min, max: p.runtimeMax ?? out.runtime?.max };
  if (p.lang) out.lang = p.lang;
  if (p.mood) out.mood = p.mood;
  if (p.playable) out.playable = true;
  return out;
}

function matches(m: Movie, f: QueryFilters): boolean {
  if (f.genres.length && !f.genres.every((g) => m.genres.includes(g))) return false;
  if (!inRange(m.year, f.year)) return false;
  if (!inRange(m.runtime, f.runtime)) return false;
  if (!inRange(m.rating, f.rating)) return false;
  if (f.lang && m.language !== f.lang) return false;
  if (f.mood && !m.moods?.includes(f.mood)) return false;
  if (f.playable && !m.playable) return false;
  if (f.director && !fold(m.director ?? '').includes(fold(f.director))) return false;
  if (f.cast && !m.cast.some((c) => fold(c).includes(fold(f.cast!)))) return false;
  return true;
}

function aliasesFor(m: Movie): string {
  const a: string[] = [];
  if (m.genres.includes('Science Fiction')) a.push('scifi sci-fi sf space future');
  if (m.genres.includes('Animation')) a.push('animated cartoon anime');
  if (m.genres.includes('Horror')) a.push('scary spooky');
  if (m.genres.includes('Romance')) a.push('romantic love romcom');
  if (m.genres.includes('Documentary')) a.push('doc docs');
  if (m.playable) a.push('free full movie public domain');
  if (m.year) a.push(`${Math.floor(m.year / 10) * 10}s ${String(Math.floor(m.year / 10) * 10).slice(2)}s`);
  return a.join(' ');
}

/** Human explanation for why a fuzzy hit matched ("Directed by …", "Starring …"). */
function why(m: Movie, match: Record<string, string[]>, text: string): string | null {
  const fields = new Set(Object.values(match).flat());
  const terms = Object.keys(match);
  if (fields.has('title')) return null;
  if (fields.has('director') && m.director) return `Directed by ${m.director}`;
  if (fields.has('cast')) {
    const c = m.cast.find((name) => terms.some((t) => fold(name).includes(t.slice(0, 4))));
    if (c) return `Starring ${c}`;
  }
  if (fields.has('keywords')) {
    const k = m.keywords.find((kw) => terms.some((t) => fold(kw).includes(t.slice(0, 4))));
    if (k) return `About: ${k}`;
  }
  if (fields.has('genres') || fields.has('aliases')) return m.genres.join(' · ');
  if (fields.has('overview')) return `Plot mentions “${text}”`;
  return null;
}
