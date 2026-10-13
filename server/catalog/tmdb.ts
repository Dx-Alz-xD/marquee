// One-shot TMDB importer → data/catalog.tmdb.json. Runs automatically on server
// start when TMDB_API_KEY is set and no catalog exists yet (or `npm run seed`).
// After seeding, the app needs no key and works fully on a LAN.
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Movie } from '../../shared/types';

const API = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p';

interface TmdbList {
  results: { id: number }[];
  total_pages: number;
}

interface TmdbMovie {
  id: number;
  title: string;
  release_date?: string;
  overview?: string;
  tagline?: string;
  genres?: { id: number; name: string }[];
  runtime?: number;
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
  original_language?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  adult?: boolean;
  credits?: { cast?: { name: string; order: number }[]; crew?: { name: string; job: string }[] };
  keywords?: { keywords?: { name: string }[] };
  videos?: { results?: { site: string; type: string; key: string; official?: boolean; iso_639_1?: string }[] };
}

export function tmdbAuth(key: string): { headers: Record<string, string>; query: string } {
  const k = key.trim();
  // v4 "Read Access Token" is a JWT; v3 "API Key" is 32 hex chars.
  return k.startsWith('eyJ') ? { headers: { Authorization: `Bearer ${k}` }, query: '' } : { headers: {}, query: `api_key=${encodeURIComponent(k)}` };
}

export async function seedTmdb(key: string, log: (msg: string) => void = console.log): Promise<number> {
  const auth = tmdbAuth(key);
  const get = async <T>(path: string, params = ''): Promise<T> => {
    const qs = [auth.query, params, 'language=en-US'].filter(Boolean).join('&');
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(`${API}${path}?${qs}`, { headers: { accept: 'application/json', ...auth.headers } });
      if (r.status === 429 && attempt < 5) {
        await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
        continue;
      }
      if (r.status === 401) throw new Error('TMDB rejected the key (401). Check TMDB_API_KEY in .env');
      if (!r.ok) throw new Error(`TMDB ${r.status} for ${path}`);
      return (await r.json()) as T;
    }
  };

  log('[tmdb] collecting movie ids…');
  const ids = new Set<number>();
  const lists: [string, number][] = [
    ['/movie/popular', 25],
    ['/movie/top_rated', 25],
    ['/trending/movie/week', 5],
    ['/movie/now_playing', 3],
  ];
  for (const [path, pages] of lists) {
    for (let p = 1; p <= pages; p++) {
      const res = await get<TmdbList>(path, `page=${p}`);
      res.results.forEach((m) => ids.add(m.id));
      if (p >= res.total_pages) break;
    }
  }
  log(`[tmdb] fetching details for ${ids.size} movies…`);

  const queue = [...ids];
  const out: Movie[] = [];
  let done = 0;
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift()!;
      try {
        const m = await get<TmdbMovie>(`/movie/${id}`, 'append_to_response=credits,keywords,videos');
        const movie = toMovie(m);
        if (movie) out.push(movie);
      } catch (e) {
        if ((e as Error).message.includes('401')) throw e;
      }
      if (++done % 100 === 0) log(`[tmdb] ${done}/${ids.size}`);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  out.sort((a, b) => b.popularity - a.popularity);
  mkdirSync(new URL('../../data/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../../data/catalog.tmdb.json', import.meta.url), JSON.stringify(out));
  log(`[tmdb] wrote ${out.length} movies → data/catalog.tmdb.json`);
  return out.length;
}

function toMovie(m: TmdbMovie): Movie | null {
  if (m.adult || !m.title) return null;
  const vids = (m.videos?.results ?? []).filter((v) => v.site === 'YouTube');
  const trailer =
    vids.find((v) => v.type === 'Trailer' && v.official && v.iso_639_1 === 'en') ??
    vids.find((v) => v.type === 'Trailer') ??
    vids.find((v) => v.type === 'Teaser') ??
    vids[0];
  const director = m.credits?.crew?.find((c) => c.job === 'Director')?.name ?? null;
  return {
    id: `tmdb:${m.id}`,
    title: m.title,
    year: m.release_date ? Number(m.release_date.slice(0, 4)) || null : null,
    overview: m.overview ?? '',
    tagline: m.tagline || null,
    genres: (m.genres ?? []).map((g) => g.name).filter((g) => g !== 'TV Movie'),
    runtime: m.runtime || null,
    rating: m.vote_count ? Math.round((m.vote_average ?? 0) * 10) / 10 : null,
    votes: m.vote_count ?? 0,
    popularity: Math.round((m.popularity ?? 0) * 10) / 10,
    language: m.original_language ?? 'en',
    director,
    cast: (m.credits?.cast ?? [])
      .sort((a, b) => a.order - b.order)
      .slice(0, 6)
      .map((c) => c.name),
    keywords: (m.keywords?.keywords ?? []).slice(0, 16).map((k) => k.name),
    poster: m.poster_path ? `${IMG}/w342${m.poster_path}` : null,
    backdrop: m.backdrop_path ? `${IMG}/w1280${m.backdrop_path}` : null,
    trailer: trailer?.key ?? null,
    playable: null,
    source: 'tmdb',
  };
}
