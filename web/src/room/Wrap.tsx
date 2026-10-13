// Movie Night Wrap — rolls for everyone when a film ends (or on demand as an
// "intermission report"): the night's top moments, awards, ratings & lineup.
import { Play, Star } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import type { MediaStats } from '@shared/types';
import { fmtTime } from '@shared/util';
import { awards, topMoments, totals, verdict } from '@shared/wrap';
import { Avatar, btn, Modal, SectionLabel, useSession } from '../components/ui';
import { cx } from '../lib/util';
import { canControl, useRoom } from '../store';

const shown = new Set<string>();

export function Wrap() {
  const wrapId = useRoom((s) => s.ui.wrap);
  const setUi = useRoom((s) => s.setUi);
  const stats = useRoom((s) => s.stats);
  const playback = useRoom((s) => s.playback);

  // Roll the credits automatically, once per film, when it ends.
  useEffect(() => {
    const id = playback?.media?.id;
    if (!id || !playback?.ended || shown.has(id)) return;
    const s = stats.find((x) => x.mediaId === id);
    if (s?.endedAt) {
      shown.add(id);
      setUi({ wrap: id });
    }
  }, [playback, stats, setUi]);

  const s = stats.find((x) => x.mediaId === wrapId) ?? null;
  return (
    <Modal open={!!s} onClose={() => setUi({ wrap: null })} label="Movie Night Wrap" className="max-w-3xl">
      {s && <WrapBody s={s} />}
    </Modal>
  );
}

function WrapBody({ s }: { s: MediaStats }) {
  const { client, engine } = useSession();
  const you = useRoom((st) => st.you);
  const members = useRoom((st) => st.members);
  const upNext = useRoom((st) => st.upNext);
  const playlist = useRoom((st) => st.playlist);
  const lineup = useRoom((st) => st.stats);
  const ctl = useRoom(canControl);
  const setUi = useRoom((st) => st.setUi);
  const ended = !!s.endedAt;
  const moments = useMemo(() => topMoments(s), [s]);
  const prizes = useMemo(() => awards(s), [s]);
  const t = totals(s);
  const v = verdict(s);
  const mine = you ? s.ratings[you] : undefined;
  const person = (id: string) => s.people[id] ?? members[id] ?? { name: 'Someone', avatar: '🎬', color: '#888888' };
  const watchedFor = s.togetherSecs ?? 0;

  return (
    <div className="max-h-[92dvh] overflow-y-auto">
      <div className="relative overflow-hidden px-6 pt-10 pb-8 text-center sm:px-10">
        {s.thumbnail && <img src={s.thumbnail} alt="" className="absolute inset-0 h-full w-full scale-110 object-cover opacity-25 blur-md" />}
        <div className="absolute inset-0 bg-gradient-to-b from-velvet/40 to-velvet" />
        <div className="relative">
          <motion.div
            initial={{ letterSpacing: '0.6em', opacity: 0 }}
            animate={{ letterSpacing: '0.2em', opacity: 1 }}
            transition={{ duration: 1.1, ease: 'easeOut' }}
            className="font-marquee text-5xl text-bulb drop-shadow-[0_0_18px_var(--color-bulb)] sm:text-7xl"
          >
            {ended ? 'THAT’S A WRAP' : 'INTERMISSION REPORT'}
          </motion.div>
          <div className="mt-2 font-serif text-2xl italic">{s.title}</div>
          <div className="mt-1 font-mono text-[11px] text-dim">
            {t.people} watching · {watchedFor ? fmtTime(watchedFor) : '—'} together · {t.reactions} reactions · {t.messages} messages
          </div>
          <div className="mt-5 flex flex-wrap justify-center gap-3">
            {Object.entries(s.people).map(([id, p]) => (
              <span key={id} className="flex flex-col items-center gap-1">
                <Avatar m={p} size={38} />
                <span className="text-[11px] text-paper/80">{p.name}</span>
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="space-y-8 px-6 pb-8 sm:px-10">
        {moments.length > 0 && (
          <section>
            <SectionLabel className="mb-3">Top moments</SectionLabel>
            <div className="grid gap-2 sm:grid-cols-3">
              {moments.map((m, i) => (
                <motion.button
                  key={m.time}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.25 + i * 0.12 }}
                  onClick={() => {
                    engine.watchMoment(Math.max(0, m.time - 3));
                    setUi({ wrap: null });
                  }}
                  className="group rounded-2xl border border-seam bg-velvet-2 p-3 text-left transition hover:border-bulb/50"
                  title="Rewatch privately (Personal Detour)"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-marquee text-3xl leading-none text-bulb">#{i + 1}</span>
                    <span className="rounded bg-beam/15 px-1.5 font-mono text-xs text-beam">{fmtTime(m.time)}</span>
                  </div>
                  <div className="mt-2 text-2xl">{m.emojis.map(([e]) => e).join(' ')}</div>
                  <div className="mt-1 flex items-center justify-between text-[11px] text-dim">
                    {m.count} reactions
                    <span className="inline-flex items-center gap-1 text-bulb opacity-0 transition group-hover:opacity-100">
                      <Play size={10} fill="currentColor" /> rewatch
                    </span>
                  </div>
                </motion.button>
              ))}
            </div>
          </section>
        )}

        {prizes.length > 0 && (
          <section>
            <SectionLabel className="mb-3">Awards</SectionLabel>
            <div className="grid gap-2 sm:grid-cols-2">
              {prizes.map((a, i) => {
                const p = person(a.memberId);
                return (
                  <motion.div
                    key={a.id}
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: 0.5 + i * 0.1 }}
                    className="flex items-center gap-3 rounded-2xl border border-seam bg-ink/40 p-3"
                  >
                    <span className="text-3xl">{a.icon}</span>
                    <div className="min-w-0 flex-1">
                      <div className="font-serif text-[17px] leading-tight">{a.title}</div>
                      <div className="truncate text-xs text-dim">{a.detail}</div>
                    </div>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <Avatar m={p} size={26} />
                      <span className="text-xs font-semibold" style={{ color: p.color }}>
                        {a.memberId === you ? 'You' : p.name}
                      </span>
                    </span>
                  </motion.div>
                );
              })}
            </div>
          </section>
        )}

        <section className="rounded-3xl border border-bulb/30 bg-bulb/5 p-5 text-center">
          <SectionLabel>{ended ? 'How was it?' : 'Liking it so far?'}</SectionLabel>
          <Stars value={mine} onRate={(n) => client.send({ t: 'rating', mediaId: s.mediaId, stars: n })} />
          <div className="mt-1 text-[11px] text-dim">Ratings tune the room’s recommendations for next time.</div>
          {v && (
            <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
              <span className="font-marquee text-3xl text-bulb">★ {v.avg.toFixed(1)}</span>
              <span className="text-xs text-dim">room verdict from {v.count}</span>
              <span className="flex flex-wrap gap-2">
                {Object.entries(s.ratings).map(([id, n]) => (
                  <span key={id} className="inline-flex items-center gap-1 rounded-full bg-velvet-2 py-0.5 pr-2 pl-0.5 text-[11px]">
                    <Avatar m={person(id)} size={20} /> {'★'.repeat(n)}
                  </span>
                ))}
              </span>
            </div>
          )}
        </section>

        {lineup.length > 1 && (
          <section>
            <SectionLabel className="mb-2">Tonight’s lineup</SectionLabel>
            <ol className="space-y-1">
              {lineup.map((x, i) => {
                const vx = verdict(x);
                return (
                  <li key={x.mediaId} className={cx('flex items-center gap-3 rounded-xl px-3 py-2 text-sm', x.mediaId === s.mediaId ? 'bg-bulb/10' : 'bg-white/[0.03]')}>
                    <span className="font-mono text-xs text-faint">{i + 1}</span>
                    <span className="flex-1 truncate">{x.title}</span>
                    <span className="font-mono text-xs text-bulb">{vx ? `★ ${vx.avg.toFixed(1)}` : '—'}</span>
                  </li>
                );
              })}
            </ol>
          </section>
        )}

        <div className="flex flex-wrap items-center justify-center gap-2">
          {upNext && <UpNextLine title={playlist.find((i) => i.id === upNext.itemId)?.media.title ?? 'Next up'} at={upNext.at} canAct={ctl} />}
          <button className={btn.ghost} onClick={() => setUi({ wrap: null })}>
            Back to the room
          </button>
        </div>
      </div>
    </div>
  );
}

function Stars({ value, onRate }: { value?: number; onRate: (n: number) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const shown = hover ?? value ?? 0;
  return (
    <div className="mt-2 flex justify-center gap-1" onMouseLeave={() => setHover(null)} role="radiogroup" aria-label="Your rating">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} star${n > 1 ? 's' : ''}`}
          onMouseEnter={() => setHover(n)}
          onClick={() => onRate(n)}
          className="p-1 transition hover:scale-125"
        >
          <Star size={30} className={n <= shown ? 'fill-bulb text-bulb drop-shadow-[0_0_8px_var(--color-bulb)]' : 'text-faint'} />
        </button>
      ))}
    </div>
  );
}

function UpNextLine({ title, at, canAct }: { title: string; at: number; canAct: boolean }) {
  const { client } = useSession();
  const [left, setLeft] = useState(Math.ceil((at - Date.now()) / 1000));
  useEffect(() => {
    const t = setInterval(() => setLeft(Math.max(0, Math.ceil((at - Date.now()) / 1000))), 250);
    return () => clearInterval(t);
  }, [at]);
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-seam bg-velvet-2 py-1 pr-1 pl-3 text-xs text-dim">
      Up next in {left}s: <b className="max-w-40 truncate text-paper">{title}</b>
      {canAct && (
        <button className={cx(btn.primary, 'px-3 py-1 text-xs')} onClick={() => client.send({ t: 'pl', op: 'next' })}>
          Play now
        </button>
      )}
    </span>
  );
}
