// A tiny search query language on top of fuzzy text search:
//
//   nolan sci-fi year:>2010 runtime:<150 rating:7+ by:villeneuve with:"amy adams" mood:cozy 90s is:free
//
// Anything that isn't an operator is free text for the fuzzy index.

export interface Range {
  min?: number;
  max?: number;
}

export interface QueryFilters {
  genres: string[];
  year?: Range;
  runtime?: Range;
  rating?: Range;
  lang?: string;
  director?: string;
  cast?: string;
  mood?: string;
  playable?: boolean;
}

export interface ParsedQuery {
  text: string;
  filters: QueryFilters;
  chips: { key: string; label: string }[];
}

export const GENRES = [
  'Action',
  'Adventure',
  'Animation',
  'Comedy',
  'Crime',
  'Documentary',
  'Drama',
  'Family',
  'Fantasy',
  'History',
  'Horror',
  'Music',
  'Mystery',
  'Romance',
  'Science Fiction',
  'Thriller',
  'War',
  'Western',
];

const GENRE_ALIASES: Record<string, string> = {
  scifi: 'Science Fiction',
  'sci-fi': 'Science Fiction',
  sf: 'Science Fiction',
  'science-fiction': 'Science Fiction',
  sciencefiction: 'Science Fiction',
  animated: 'Animation',
  anime: 'Animation',
  cartoon: 'Animation',
  cartoons: 'Animation',
  doc: 'Documentary',
  docs: 'Documentary',
  scary: 'Horror',
  musical: 'Music',
  romcom: 'Romance',
  noir: 'Crime',
  kids: 'Family',
  historical: 'History',
};

export function resolveGenre(raw: string): string | null {
  const k = raw.toLowerCase().replace(/["']/g, '');
  if (GENRE_ALIASES[k]) return GENRE_ALIASES[k];
  return GENRES.find((g) => g.toLowerCase() === k || g.toLowerCase().replace(/\s+/g, '-') === k) ?? null;
}

const KEY_ALIASES: Record<string, string> = {
  y: 'year',
  year: 'year',
  g: 'genre',
  genre: 'genre',
  rt: 'runtime',
  len: 'runtime',
  length: 'runtime',
  runtime: 'runtime',
  r: 'rating',
  rating: 'rating',
  l: 'lang',
  lang: 'lang',
  language: 'lang',
  by: 'director',
  dir: 'director',
  director: 'director',
  with: 'cast',
  cast: 'cast',
  actor: 'cast',
  starring: 'cast',
  m: 'mood',
  mood: 'mood',
  is: 'is',
};

/** ">2010" | ">=2010" | "<150" | "2000-2010" | "2000..2010" | "7+" | "90s" | "2010" */
export function parseRange(v: string, kind: 'year' | 'number'): Range | null {
  let m: RegExpMatchArray | null;
  if ((m = v.match(/^(>=|<=|>|<)(\d+(?:\.\d+)?)$/))) {
    const n = Number(m[2]);
    const eps = kind === 'year' ? 1 : 0.0001;
    if (m[1] === '>') return { min: n + (kind === 'year' ? eps : 0) };
    if (m[1] === '>=') return { min: n };
    if (m[1] === '<') return { max: n - (kind === 'year' ? eps : 0) };
    return { max: n };
  }
  if ((m = v.match(/^(\d+(?:\.\d+)?)\+$/))) return { min: Number(m[1]) };
  if ((m = v.match(/^(\d+(?:\.\d+)?)(?:-|\.\.)(\d+(?:\.\d+)?)$/))) return { min: Number(m[1]), max: Number(m[2]) };
  if (kind === 'year') {
    const d = decade(v);
    if (d) return d;
  }
  if ((m = v.match(/^\d+(?:\.\d+)?$/))) return kind === 'year' ? { min: Number(v), max: Number(v) } : { min: Number(v) };
  return null;
}

/** "90s" → 1990–1999, "1960s" → 1960–1969, "2010s" → 2010–2019 */
export function decade(v: string): Range | null {
  const m = v.match(/^(\d{2}|\d{4})s$/i);
  if (!m) return null;
  let start = Number(m[1]);
  if (m[1].length === 2) start += start >= 30 ? 1900 : 2000;
  return { min: start, max: start + 9 };
}

function tokenize(q: string): string[] {
  const out: string[] = [];
  const re = /(\w+):"([^"]*)"|"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) {
    if (m[1]) out.push(`${m[1]}:${m[2]}`);
    else if (m[3] !== undefined) out.push(m[3]);
    else out.push(m[4]);
  }
  return out;
}

export function parseQuery(q: string, moods: string[] = []): ParsedQuery {
  const filters: QueryFilters = { genres: [] };
  const chips: ParsedQuery['chips'] = [];
  const free: string[] = [];
  const fmt = (r: Range, unit = '') =>
    r.min != null && r.max != null ? (r.min === r.max ? `${r.min}${unit}` : `${r.min}–${r.max}${unit}`) : r.min != null ? `≥ ${r.min}${unit}` : `≤ ${r.max}${unit}`;

  for (const tok of tokenize(q)) {
    const kv = tok.match(/^([a-z]+):(.+)$/i);
    const key = kv ? KEY_ALIASES[kv[1].toLowerCase()] : undefined;
    if (kv && key) {
      const val = kv[2].trim();
      switch (key) {
        case 'year': {
          const r = parseRange(val, 'year');
          if (r) (filters.year = r), chips.push({ key: 'year', label: `Year ${fmt(r)}` });
          continue;
        }
        case 'runtime': {
          const r = parseRange(val, 'number');
          if (r) (filters.runtime = r), chips.push({ key: 'runtime', label: `Runtime ${fmt(r, ' min')}` });
          continue;
        }
        case 'rating': {
          const r = parseRange(val, 'number');
          if (r) (filters.rating = r), chips.push({ key: 'rating', label: `Rating ${fmt(r)}` });
          continue;
        }
        case 'genre': {
          const g = resolveGenre(val);
          if (g) filters.genres.push(g), chips.push({ key: 'genre', label: g });
          continue;
        }
        case 'lang':
          filters.lang = val.toLowerCase().slice(0, 2);
          chips.push({ key: 'lang', label: `Language: ${filters.lang}` });
          continue;
        case 'director':
          filters.director = val;
          chips.push({ key: 'director', label: `Directed by ${val}` });
          continue;
        case 'cast':
          filters.cast = val;
          chips.push({ key: 'cast', label: `Starring ${val}` });
          continue;
        case 'mood': {
          const mood = moods.find((m) => m.startsWith(val.toLowerCase())) ?? val.toLowerCase();
          filters.mood = mood;
          chips.push({ key: 'mood', label: `Mood: ${mood}` });
          continue;
        }
        case 'is':
          if (/^(free|playable|full)$/i.test(val)) {
            filters.playable = true;
            chips.push({ key: 'playable', label: 'Free to watch' });
          }
          continue;
      }
    }
    // Bare decades ("90s") and genre words ("sci-fi") become filters too.
    const d = decade(tok);
    if (d && !filters.year) {
      filters.year = d;
      chips.push({ key: 'year', label: `${d.min}s` });
      continue;
    }
    const g = /^[a-z-]+$/i.test(tok) ? resolveGenre(tok) : null;
    if (g && GENRE_ALIASES[tok.toLowerCase()]) {
      filters.genres.push(g);
      chips.push({ key: 'genre', label: g });
      continue;
    }
    free.push(tok);
  }
  return { text: free.join(' ').trim(), filters, chips };
}

export function inRange(v: number | null | undefined, r?: Range): boolean {
  if (!r) return true;
  if (v == null) return false;
  if (r.min != null && v < r.min) return false;
  if (r.max != null && v > r.max) return false;
  return true;
}

/** Lowercase + strip diacritics + drop apostrophes: "Amélie" → "amelie", "Schindler's" → "schindlers". */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '');
}
