// Group Pick — everyone swipes on the same shortlist (built by the group
// recommender) at the same time. The first title everyone likes wins.
import { Heart, Star, Wand2, X } from 'lucide-react';
import { AnimatePresence, motion, useMotionValue, useTransform } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import type { Movie, PickSession } from '@shared/types';
import { Avatar, btn, Modal, Poster, useSession } from '../components/ui';
import { api, cx } from '../lib/util';
import { canControl, useRoom } from '../store';

export function GroupPick() {
  const open = useRoom((s) => s.ui.pick);
  const setUi = useRoom((s) => s.setUi);
  const pick = useRoom((s) => s.pick);
  return (
    <Modal open={open} onClose={() => setUi({ pick: false })} label="Group Pick" className="max-w-xl">
      <div className="max-h-[92dvh] overflow-y-auto p-6 sm:p-8">{pick?.status === 'active' ? <Swiping pick={pick} /> : <Intro last={pick} />}</div>
    </Modal>
  );
}

function useMovies(ids: string[]) {
  const [movies, setMovies] = useState<Record<string, Movie>>({});
  const key = ids.join(',');
  useEffect(() => {
    if (!ids.length) return;
    api<{ movies: Movie[] }>(`/api/movies?ids=${encodeURIComponent(key)}`)
      .then((r) => setMovies(Object.fromEntries(r.movies.map((m) => [m.id, m]))))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return movies;
}

function Intro({ last }: { last: PickSession | null }) {
  const { client } = useSession();
  const online = useRoom((s) => Object.values(s.members).filter((m) => m.online).length);
  const movies = useMovies(last?.results?.slice(0, 5).map((r) => r.movieId) ?? []);
  const setUi = useRoom((s) => s.setUi);
  const match = last?.match ? movies[last.match] : null;
  return (
    <div className="text-center">
      {last && last.status !== 'active' && (
        <div className="mb-8">
          {match ? (
            <div className="flex flex-col items-center">
              <div className="font-marquee text-5xl tracking-wider text-bulb drop-shadow-[0_0_16px_var(--color-bulb)]">{last.status === 'matched' ? 'IT’S A MATCH' : 'WE HAVE A WINNER'}</div>
              <Poster movie={match} className="mt-4 w-40 shadow-[0_20px_60px_-10px_var(--color-bulb)]" />
              <div className="mt-3 font-serif text-2xl">{match.title}</div>
              <div className="mt-1 text-sm text-dim">Queued up next for everyone.</div>
            </div>
          ) : (
            <div className="text-dim">Last round ended without a clear winner.</div>
          )}
          {last.results && last.results.length > 0 && (
            <div className="mx-auto mt-5 max-w-sm space-y-1 text-left">
              {last.results.slice(0, 5).map((r) => (
                <div key={r.movieId} className="flex items-center gap-2 text-sm">
                  <span className="w-10 font-mono text-xs text-bulb">❤ {r.likes}</span>
                  <span className="flex-1 truncate">{movies[r.movieId]?.title ?? '…'}</span>
                  <span className="truncate text-[11px] text-faint">{r.likedBy.join(', ')}</span>
                </div>
              ))}
            </div>
          )}
          <div className="mx-auto mt-6 h-px w-24 bg-seam" />
        </div>
      )}
      <Wand2 className="mx-auto text-bulb" size={30} />
      <h2 className="mt-3 font-serif text-3xl">Can’t decide? Swipe together.</h2>
      <p className="mx-auto mt-2 max-w-sm text-sm text-dim">
        Everyone gets the same shortlist, picked from the whole room’s taste. Swipe right on what you’d watch — the first film all {online} of you like wins.
      </p>
      <div className="mt-6 flex justify-center gap-2">
        <button className={btn.primary} onClick={() => client.send({ t: 'pick', op: 'start' })}>
          <Wand2 size={16} /> Start Group Pick
        </button>
        <button className={btn.ghost} onClick={() => setUi({ pick: false })}>
          Not now
        </button>
      </div>
      <p className="mt-4 text-[11px] text-faint">Your swipes teach the room’s recommender, so the next shortlist gets better.</p>
    </div>
  );
}

function Swiping({ pick }: { pick: PickSession }) {
  const { client } = useSession();
  const myPick = useRoom((s) => s.myPick);
  const members = useRoom((s) => s.members);
  const you = useRoom((s) => s.you);
  const ctl = useRoom(canControl);
  const movies = useMovies(pick.candidates);
  const remaining = pick.candidates.filter((id) => !(id in myPick));
  const current = remaining[0];
  const [exit, setExit] = useState<1 | -1>(1);

  const swipe = (like: boolean) => {
    if (!current) return;
    setExit(like ? 1 : -1);
    useRoom.setState((s) => ({ myPick: { ...s.myPick, [current]: like } }));
    client.send({ t: 'pick', op: 'swipe', movieId: current, like });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') swipe(true);
      if (e.key === 'ArrowLeft') swipe(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const participants = pick.participants.map((id) => members[id]).filter(Boolean);

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <div className="font-mono text-[10px] tracking-[0.25em] text-faint uppercase">Group Pick · started by {pick.startedByName}</div>
          <div className="font-serif text-2xl">{current ? 'Would you watch this?' : 'Waiting for the others…'}</div>
        </div>
        <div className="font-mono text-sm text-dim">
          {pick.candidates.length - remaining.length}/{pick.candidates.length}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {participants.map((m) => (
          <span key={m.id} className="inline-flex items-center gap-1.5 rounded-full bg-velvet-2 py-0.5 pr-2.5 pl-0.5 text-[11px] text-dim">
            <Avatar m={m} size={20} />
            {pick.progress[m.id] ?? 0}/{pick.candidates.length}
          </span>
        ))}
      </div>

      <div className="relative mt-5 h-[min(440px,50dvh)]">
        <AnimatePresence custom={exit}>
          {current ? (
            <Card key={current} movie={movies[current]} reason={pick.reasons[current]} onSwipe={swipe} exitDir={exit} />
          ) : (
            <motion.div key="done" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="grid h-full place-items-center text-center">
              <div>
                <div className="text-5xl">🍿</div>
                <p className="mt-3 text-dim">You’ve swiped everything. The moment everyone agrees, it’s a match.</p>
                {(pick.startedBy === you || ctl) && (
                  <button className={cx(btn.ghost, 'mt-4')} onClick={() => client.send({ t: 'pick', op: 'end' })}>
                    End the round now
                  </button>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {current && (
        <div className="mt-4 flex items-center justify-center gap-6">
          <button className="grid size-16 place-items-center rounded-full border border-seam bg-velvet-2 text-alarm transition hover:scale-110 hover:border-alarm" onClick={() => swipe(false)} aria-label="Nope">
            <X size={28} />
          </button>
          <span className="font-mono text-[10px] text-faint">← / →</span>
          <button className="grid size-16 place-items-center rounded-full bg-bulb text-ink shadow-[0_0_30px_-6px_var(--color-bulb)] transition hover:scale-110" onClick={() => swipe(true)} aria-label="I'd watch it">
            <Heart size={28} fill="currentColor" />
          </button>
        </div>
      )}
    </div>
  );
}

function Card({ movie, reason, onSwipe, exitDir }: { movie?: Movie; reason: string | null | undefined; onSwipe: (like: boolean) => void; exitDir: 1 | -1 }) {
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-200, 200], [-14, 14]);
  const likeOpacity = useTransform(x, [30, 120], [0, 1]);
  const nopeOpacity = useTransform(x, [-120, -30], [1, 0]);
  const genres = useMemo(() => movie?.genres.slice(0, 3).join(' · '), [movie]);
  return (
    <motion.div
      className="absolute inset-0 cursor-grab overflow-hidden rounded-3xl border border-seam bg-velvet-2 shadow-2xl active:cursor-grabbing"
      style={{ x, rotate }}
      drag="x"
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={0.9}
      onDragEnd={(_, info) => {
        if (info.offset.x > 110) onSwipe(true);
        else if (info.offset.x < -110) onSwipe(false);
      }}
      initial={{ scale: 0.92, opacity: 0, y: 20 }}
      animate={{ scale: 1, opacity: 1, y: 0 }}
      exit={{ x: exitDir * 420, opacity: 0, rotate: exitDir * 20, transition: { duration: 0.3 } }}
    >
      {movie ? (
        <>
          {(movie.backdrop || movie.poster) && <img src={movie.backdrop ?? movie.poster!} alt="" className="absolute inset-0 h-full w-full object-cover" draggable={false} />}
          <div className="absolute inset-0 bg-gradient-to-t from-ink via-ink/70 to-transparent" />
          <motion.div style={{ opacity: likeOpacity }} className="absolute top-6 left-6 -rotate-12 rounded-lg border-4 border-ok px-3 py-1 font-marquee text-4xl tracking-widest text-ok">
            WATCH
          </motion.div>
          <motion.div style={{ opacity: nopeOpacity }} className="absolute top-6 right-6 rotate-12 rounded-lg border-4 border-alarm px-3 py-1 font-marquee text-4xl tracking-widest text-alarm">
            PASS
          </motion.div>
          <div className="absolute inset-x-0 bottom-0 p-6">
            {reason && <div className="mb-2 inline-block rounded-full bg-bulb/20 px-2.5 py-1 text-[11px] font-semibold text-bulb backdrop-blur">{reason}</div>}
            <div className="font-serif text-3xl leading-tight">{movie.title}</div>
            <div className="mt-1 flex items-center gap-2 font-mono text-xs text-dim">
              {movie.year}
              {movie.rating != null && (
                <>
                  <Star size={11} className="fill-bulb text-bulb" />
                  {movie.rating.toFixed(1)}
                </>
              )}
              {movie.runtime && <> · {movie.runtime} min</>}
              {movie.playable && <span className="rounded bg-bulb px-1 font-bold text-ink">FREE</span>}
            </div>
            <div className="mt-1 text-xs text-dim">{genres}</div>
            <p className="mt-2 line-clamp-3 text-sm text-paper/85">{movie.overview}</p>
          </div>
        </>
      ) : (
        <div className="skeleton h-full w-full" />
      )}
    </motion.div>
  );
}
