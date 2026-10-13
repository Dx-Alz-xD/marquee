// "What you missed" — for late joiners: the reaction peaks and chat buzz from
// before you arrived. Tapping a moment replays it privately (Personal Detour).
import { MessageCircle, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo } from 'react';
import { fmtTime } from '@shared/util';
import { topMoments } from '@shared/wrap';
import { useSession } from '../components/ui';
import { useRoom } from '../store';

export function CatchUp() {
  const { engine } = useSession();
  const catchup = useRoom((s) => s.catchup);
  const stats = useRoom((s) => s.stats);
  const chat = useRoom((s) => s.chat);
  const mediaId = useRoom((s) => s.playback?.media?.id);
  const setUi = useRoom((s) => s.setUi);
  const dismiss = () => useRoom.setState({ catchup: null });

  const data = useMemo(() => {
    if (!catchup || catchup.mediaId !== mediaId) return null;
    const s = stats.find((x) => x.mediaId === catchup.mediaId);
    const moments = s ? topMoments(s, { before: catchup.position, limit: 3 }) : [];
    const messages = chat.filter((c) => c.kind === 'user' && c.ts < catchup.joinedAt && (s ? c.ts >= s.startedAt : true)).length;
    if (!moments.length && !messages) return null;
    return { moments, messages };
  }, [catchup, stats, chat, mediaId]);

  useEffect(() => {
    if (!catchup) return;
    const t = setTimeout(dismiss, 40_000);
    return () => clearTimeout(t);
  }, [catchup]);

  return (
    <AnimatePresence>
      {catchup && data && (
        <motion.div
          initial={{ opacity: 0, x: -16 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -16 }}
          className="absolute top-3 left-3 z-[28] w-[min(320px,calc(100%-1.5rem))] rounded-2xl border border-bulb/30 bg-ink/90 p-3.5 shadow-2xl backdrop-blur"
        >
          <button className="absolute top-2 right-2 rounded-full p-1 text-dim hover:text-paper" onClick={dismiss} aria-label="Dismiss">
            <X size={14} />
          </button>
          <div className="font-mono text-[10px] tracking-[0.2em] text-bulb uppercase">You joined {fmtTime(catchup.position)} in</div>
          <div className="mt-0.5 font-serif text-lg leading-tight">Here’s what you missed</div>
          {data.moments.length > 0 && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {data.moments.map((m) => (
                <button
                  key={m.time}
                  onClick={() => engine.watchMoment(Math.max(0, m.time - 3))}
                  className="inline-flex items-center gap-1.5 rounded-full border border-seam bg-velvet-2 px-2.5 py-1 text-xs transition hover:border-bulb/60"
                  title="Watch it privately, then GO LIVE to rejoin"
                >
                  <span>{m.emojis.map(([e]) => e).join('')}</span>
                  <span className="font-mono text-beam">{fmtTime(m.time)}</span>
                  <span className="text-faint">×{m.count}</span>
                </button>
              ))}
            </div>
          )}
          {data.messages > 0 && (
            <button className="mt-2 inline-flex items-center gap-1.5 text-xs text-dim hover:text-paper" onClick={() => setUi({ tab: 'chat' })}>
              <MessageCircle size={12} /> {data.messages} chat message{data.messages === 1 ? '' : 's'} before you arrived
            </button>
          )}
          {data.moments.length > 0 && <div className="mt-2 text-[10px] text-faint">Tap a moment to rewatch it on your own — hit GO LIVE to rejoin.</div>}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
