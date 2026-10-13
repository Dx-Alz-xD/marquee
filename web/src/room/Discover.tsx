import { ArrowLeft, Clock, Film, ListPlus, Megaphone, Play, Search, SkipForward, Sparkles, Star, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Member, Movie, MovieHit, Shelf } from '@shared/types';
import { Avatar, btn, Modal, Poster, SectionLabel, useSession } from '../components/ui';
import { api, cx, minutesToMidnight, type CatalogMeta, type SearchResponse } from '../lib/util';
import { canControl, useRoom } from '../store';

const SORTS = [
  ['relevance', 'Best match'],
  ['popularity', 'Popular'],
  ['rating', 'Top rated'],
  ['year', 'Newest'],
  ['runtime', 'Shortest'],
] as const;

export function Discover() {
  const open = useRoom((s) => s.ui.discover);
  const setUi = useRoom((s) => s.setUi);
  const movieId = useRoom((s) => s.ui.movieId);
  const { client } = useSession();
  const close = () => {
    setUi({ discover: false, movieId: null });
    client.send({ t: 'browse', movieId: null });
  };
  return (
    <Modal open={open} onClose={close} label="Discover movies" className="flex h-[92dvh] max-w-6xl flex-col">
      {movieId ? <MovieDetail id={movieId} /> : <Browser />}
    </Modal>
  );
}

function Browser() {
  const code = useRoom((s) => s.code);
  const [meta, setMeta] = useState<CatalogMeta & { tmdb?: { configured: boolean; seeding: boolean } } | null>(null);
  const [q, setQ] = useState('');
  const [genres, setGenres] = useState<string[]>([]);
  const [mood, setMood] = useState('');
  const [free, setFree] = useState(false);
  const [decade, setDecade] = useState('');
  const [ratingMin, setRatingMin] = useState('');
  const [runtimeMax, setRuntimeMax] = useState('');
  const [sort, setSort] = useState<(typeof SORTS)[number][0]>('relevance');
  const [res, setRes] = useState<SearchResponse | null>(null);
  const [shelves, setShelves] = useState<Shelf[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtering = !!(q.trim() || genres.length || mood || free || decade || ratingMin || runtimeMax || sort !== 'relevance');

  useEffect(() => {
    api<CatalogMeta>('/api/movies/meta').then(setMeta).catch(() => {});
    api<{ shelves: Shelf[] }>(`/api/movies/shelves?room=${code}&minutesLeft=${minutesToMidnight()}`)
      .then((r) => setShelves(r.shelves))
      .catch(() => setShelves([]));
    inputRef.current?.focus();
  }, [code]);

  useEffect(() => {
    if (!filtering) return setRes(null);
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      const p = new URLSearchParams({ q, sort, limit: '60' });
      if (genres.length) p.set('genres', genres.join(','));
      if (mood) p.set('mood', mood);
      if (free) p.set('playable', '1');
      if (decade) {
        p.set('yearMin', decade);
        p.set('yearMax', String(Number(decade) + 9));
      }
      if (ratingMin) p.set('ratingMin', ratingMin);
      if (runtimeMax) p.set('runtimeMax', runtimeMax);
      fetch(`/api/movies/search?${p}`, { signal: ctrl.signal })
        .then((r) => r.json())
        .then(setRes)
        .catch(() => {});
    }, 110);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q, genres, mood, free, decade, ratingMin, runtimeMax, sort, filtering]);

  const clear = () => {
    setQ('');
    setGenres([]);
    setMood('');
    setFree(false);
    setDecade('');
    setRatingMin('');
    setRuntimeMax('');
    setSort('relevance');
  };

  const decades = useMemo(() => {
    if (!meta) return [];
    const out: number[] = [];
    for (let d = Math.floor(meta.yearMin / 10) * 10; d <= meta.yearMax; d += 10) out.push(d);
    return out.reverse();
  }, [meta]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-seam px-5 pt-5 pb-3 sm:px-7">
        <div className="flex items-end justify-between gap-4 pr-10">
          <div>
            <div className="font-mono text-[10px] tracking-[0.25em] text-faint uppercase">Discover</div>
            <h2 className="font-serif text-3xl leading-tight">What are we watching?</h2>
          </div>
          {meta && <div className="hidden pb-1 font-mono text-[11px] text-faint sm:block">{meta.total.toLocaleString()} films · {meta.playable} free to stream</div>}
        </div>
        <div className="relative mt-4">
          <Search size={18} className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-faint" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder='Search titles, people, plots — try “nolan sci-fi” or “year:<1950 is:free”'
            aria-label="Search movies"
            className="w-full rounded-2xl border border-seam bg-ink/70 py-3.5 pr-28 pl-11 text-[15px] outline-none placeholder:text-faint focus:border-bulb/60"
          />
          {res && <span className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 font-mono text-[10px] text-faint">{res.tookMs} ms</span>}
        </div>
        {res?.parsed.chips.length ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-dim">
            understood:
            {res.parsed.chips.map((c, i) => (
              <span key={i} className="rounded-full bg-beam/15 px-2 py-0.5 font-mono text-beam">
                {c.label}
              </span>
            ))}
          </div>
        ) : null}
        <div className="no-scrollbar mt-3 flex items-center gap-1.5 overflow-x-auto pb-1">
          <button className={free ? btn.chipOn : btn.chip} onClick={() => setFree(!free)}>
            <Film size={12} /> Free full movies
          </button>
          <Select value={mood} onChange={setMood} label="Mood" options={(meta?.moods ?? []).map((m) => [m.id, m.title])} />
          <Select value={decade} onChange={setDecade} label="Decade" options={decades.map((d) => [String(d), `${d}s`])} />
          <Select value={ratingMin} onChange={setRatingMin} label="Rating" options={['8', '7.5', '7', '6'].map((r) => [r, `★ ${r}+`])} />
          <Select value={runtimeMax} onChange={setRuntimeMax} label="Length" options={[['90', '≤ 90 min'], ['120', '≤ 2 h'], ['150', '≤ 2.5 h']]} />
          <Select value={sort === 'relevance' ? '' : sort} onChange={(v) => setSort((v || 'relevance') as typeof sort)} label="Sort: best match" options={SORTS.filter(([v]) => v !== 'relevance').map(([v, l]) => [v, l])} />
          <span className="mx-1 h-5 w-px shrink-0 bg-seam" />
          {(meta?.genres ?? []).map((g) => (
            <button key={g} className={genres.includes(g) ? btn.chipOn : btn.chip} onClick={() => setGenres(genres.includes(g) ? genres.filter((x) => x !== g) : [...genres, g])}>
              {g}
            </button>
          ))}
          {filtering && (
            <button className={cx(btn.chip, 'text-alarm')} onClick={clear}>
              <X size={12} /> Clear
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-7">
        {meta && meta.total < 100 && !filtering && <TmdbHint />}
        {filtering ? (
          res ? (
            res.results.length ? (
              <>
                <div className="mb-3 text-xs text-dim">
                  {res.total} result{res.total === 1 ? '' : 's'}
                  {res.parsed.text && <> for “{res.parsed.text}”</>}
                </div>
                <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
                  {res.results.map((m) => (
                    <MovieTile key={m.id} m={m} />
                  ))}
                </div>
              </>
            ) : (
              <div className="py-16 text-center">
                <div className="font-serif text-2xl">Nothing matches that.</div>
                <p className="mt-2 text-sm text-dim">Loosen a filter, or try a person’s name or a plot word — the search forgives typos.</p>
              </div>
            )
          ) : (
            <GridSkeleton />
          )
        ) : shelves ? (
          <div className="space-y-8">
            {shelves.map((s) => (
              <ShelfRow key={s.id} shelf={s} />
            ))}
          </div>
        ) : (
          <GridSkeleton />
        )}
        <p className="mt-10 pb-2 text-center text-[10px] text-faint">
          Film data &amp; images from TMDB (not endorsed by TMDB) · free films via the Internet Archive and the Blender Foundation
        </p>
      </div>
    </div>
  );
}

function Select({ value, onChange, label, options }: { value: string; onChange: (v: string) => void; label: string; options: (readonly [string, string])[] | string[][] }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
      className={cx('shrink-0 cursor-pointer appearance-none rounded-full border py-1 pr-3 pl-3 text-xs font-medium outline-none', value ? 'border-bulb/60 bg-bulb/15 text-bulb' : 'border-seam bg-velvet-2 text-dim')}
    >
      <option value="">{label}</option>
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
}

function TmdbHint() {
  return (
    <div className="mb-6 flex items-start gap-3 rounded-2xl border border-beam/30 bg-beam/5 p-4 text-sm">
      <Sparkles size={18} className="mt-0.5 shrink-0 text-beam" />
      <div>
        <div className="font-semibold text-beam">Running on the free classics catalog</div>
        <div className="mt-0.5 text-dim">
          Add a TMDB key to <code className="rounded bg-ink px-1 font-mono text-xs">.env</code> and restart the server to unlock ~1,000 popular films with trailers, cast and posters.
        </div>
      </div>
    </div>
  );
}

function GridSkeleton() {
  return (
    <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
      {Array.from({ length: 12 }, (_, i) => (
        <div key={i} className="skeleton aspect-[2/3] rounded-xl" />
      ))}
    </div>
  );
}

function ShelfRow({ shelf }: { shelf: Shelf }) {
  return (
    <section>
      <div className="mb-2.5 flex items-baseline gap-3">
        <h3 className={cx('font-serif text-xl', shelf.id === 'for-room' && 'text-bulb')}>{shelf.title}</h3>
        {shelf.subtitle && <span className="truncate text-xs text-dim">{shelf.subtitle}</span>}
      </div>
      <div className="no-scrollbar -mx-1 flex gap-3 overflow-x-auto px-1 pb-2">
        {shelf.movies.map((m) => (
          <div key={m.id} className="w-[132px] shrink-0 sm:w-[150px]">
            <MovieTile m={m} />
          </div>
        ))}
      </div>
    </section>
  );
}

function useBrowsers(movieId: string): Member[] {
  const members = useRoom((s) => s.members);
  const you = useRoom((s) => s.you);
  return useMemo(() => Object.values(members).filter((m) => m.browsing === movieId && m.id !== you && m.online), [members, movieId, you]);
}

function MovieTile({ m }: { m: MovieHit }) {
  const setUi = useRoom((s) => s.setUi);
  const browsers = useBrowsers(m.id);
  return (
    <div>
      <Poster movie={m} onClick={() => setUi({ movieId: m.id })} className="w-full">
        {m.playable && <span className="absolute top-2 left-2 rounded-md bg-bulb px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-wider text-ink">FREE</span>}
        {browsers.length > 0 && (
          <span className="absolute top-2 right-2 flex -space-x-1.5" title={`${browsers.map((b) => b.name).join(', ')} looking at this`}>
            {browsers.slice(0, 3).map((b) => (
              <Avatar key={b.id} m={b} size={22} className="ring-2 ring-ink" />
            ))}
          </span>
        )}
      </Poster>
      <div className="mt-1.5 truncate text-[13px] font-medium">{m.title}</div>
      <div className="flex items-center gap-1.5 font-mono text-[10px] text-faint">
        {m.year}
        {m.rating ? (
          <>
            <Star size={9} className="fill-bulb text-bulb" />
            {m.rating.toFixed(1)}
          </>
        ) : null}
        {m.runtime ? <> · {m.runtime}m</> : null}
      </div>
      {m.reason && <div className="mt-0.5 line-clamp-2 text-[11px] leading-tight text-bulb/85">{m.reason}</div>}
    </div>
  );
}

// ─── Detail view ─────────────────────────────────────────────────────────────
function MovieDetail({ id }: { id: string }) {
  const { client } = useSession();
  const setUi = useRoom((s) => s.setUi);
  const ctl = useRoom(canControl);
  const browsers = useBrowsers(id);
  const [data, setData] = useState<{ movie: Movie; similar: Movie[] } | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setDone(null);
    api<{ movie: Movie; similar: Movie[] }>(`/api/movies/${encodeURIComponent(id)}`).then(setData).catch(() => {});
    client.send({ t: 'browse', movieId: id });
  }, [id, client]);

  const m = data?.movie;
  const act = (label: string, fn: () => void) => () => {
    fn();
    setDone(label);
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="relative">
        <div className="absolute inset-0 h-80 overflow-hidden">
          {m?.backdrop && <img src={m.backdrop} alt="" className="h-full w-full object-cover opacity-40" />}
          <div className="absolute inset-0 bg-gradient-to-b from-velvet/30 via-velvet/80 to-velvet" />
        </div>
        <div className="relative px-5 pt-5 sm:px-8">
          <button className={btn.ghost} onClick={() => setUi({ movieId: null })}>
            <ArrowLeft size={15} /> All movies
          </button>
          {!m ? (
            <div className="mt-6 flex gap-6">
              <div className="skeleton aspect-[2/3] w-44 rounded-xl" />
              <div className="flex-1 space-y-3">
                <div className="skeleton h-10 w-2/3 rounded" />
                <div className="skeleton h-4 w-1/3 rounded" />
              </div>
            </div>
          ) : (
            <div className="mt-6 flex flex-col gap-6 sm:flex-row">
              <Poster movie={m} className="w-40 shrink-0 shadow-2xl sm:w-52" />
              <div className="min-w-0 flex-1">
                <h2 className="font-serif text-4xl leading-[1.05] sm:text-5xl">{m.title}</h2>
                {m.tagline && <div className="mt-2 font-serif text-lg text-dim italic">{m.tagline}</div>}
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-dim">
                  {m.year && <span>{m.year}</span>}
                  {m.runtime && (
                    <span className="inline-flex items-center gap-1">
                      <Clock size={11} /> {Math.floor(m.runtime / 60) ? `${Math.floor(m.runtime / 60)}h ` : ''}
                      {m.runtime % 60}m
                    </span>
                  )}
                  {m.rating != null && (
                    <span className="inline-flex items-center gap-1">
                      <Star size={11} className="fill-bulb text-bulb" /> {m.rating.toFixed(1)}
                    </span>
                  )}
                  <span>{m.genres.join(' · ')}</span>
                </div>
                <p className="mt-4 max-w-2xl leading-relaxed text-paper/85">{m.overview}</p>
                <div className="mt-3 space-y-0.5 text-sm text-dim">
                  {m.director && (
                    <div>
                      Directed by <span className="text-paper">{m.director}</span>
                    </div>
                  )}
                  {m.cast.length > 0 && (
                    <div>
                      Starring <span className="text-paper">{m.cast.slice(0, 4).join(', ')}</span>
                    </div>
                  )}
                </div>
                <div className="mt-5 flex flex-wrap items-center gap-2">
                  <span className={cx('rounded-md px-2 py-1 font-mono text-[10px] font-bold tracking-wider', m.playable ? 'bg-bulb text-ink' : 'bg-white/10 text-dim')}>
                    {m.playable ? 'FULL MOVIE · FREE' : m.trailer ? 'TRAILER' : 'NOT STREAMABLE'}
                  </span>
                  {(m.playable || m.trailer) && (
                    <>
                      {ctl && (
                        <button className={btn.primary} onClick={act('Starting for everyone…', () => client.send({ t: 'pl', op: 'addMovie', movieId: m.id, playNow: true }))}>
                          <Play size={15} fill="currentColor" /> Play for everyone
                        </button>
                      )}
                      <button className={btn.ghost} onClick={act('Queued up next', () => client.send({ t: 'pl', op: 'addMovie', movieId: m.id, next: true }))}>
                        <SkipForward size={14} /> Play next
                      </button>
                      <button className={btn.ghost} onClick={act('Added to the queue', () => client.send({ t: 'pl', op: 'addMovie', movieId: m.id }))}>
                        <ListPlus size={14} /> Queue
                      </button>
                    </>
                  )}
                  <button className={btn.ghost} onClick={act('Suggested in chat', () => client.send({ t: 'suggest', movieId: m.id }))}>
                    <Megaphone size={14} /> Suggest to the room
                  </button>
                </div>
                <AnimatePresence>
                  {done && (
                    <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-2 text-sm text-ok">
                      ✓ {done}
                    </motion.div>
                  )}
                </AnimatePresence>
                {browsers.length > 0 && (
                  <div className="mt-4 flex items-center gap-2 text-xs text-dim">
                    <span className="flex -space-x-1.5">
                      {browsers.map((b) => (
                        <Avatar key={b.id} m={b} size={22} className="ring-2 ring-velvet" />
                      ))}
                    </span>
                    {browsers.map((b) => b.name).join(', ')} {browsers.length === 1 ? 'is' : 'are'} looking at this too
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      {data && data.similar.length > 0 && (
        <div className="px-5 py-8 sm:px-8">
          <SectionLabel className="mb-3">If you like this</SectionLabel>
          <div className="no-scrollbar flex gap-3 overflow-x-auto pb-2">
            {data.similar.map((s) => (
              <div key={s.id} className="w-[130px] shrink-0">
                <MovieTile m={s} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
