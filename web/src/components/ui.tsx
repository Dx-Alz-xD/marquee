import { X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import type { Member, MovieHit } from '@shared/types';
import type { RoomClient } from '../net/client';
import { useRoom } from '../store';
import type { SyncEngine } from '../sync/engine';
import type { VoiceManager } from '../voice/voice';
import { cx, titleHue } from '../lib/util';

// ─── Session context (client + engine for the current room) ─────────────────
export interface Session {
  client: RoomClient;
  engine: SyncEngine;
  voice: VoiceManager;
}
export const SessionCtx = createContext<Session | null>(null);
export function useSession(): Session {
  const s = useContext(SessionCtx);
  if (!s) throw new Error('No session');
  return s;
}

// ─── Buttons ─────────────────────────────────────────────────────────────────
export const btn = {
  primary:
    'inline-flex items-center justify-center gap-2 rounded-full bg-bulb px-5 py-2.5 font-semibold text-ink shadow-[0_0_30px_-8px_var(--color-bulb)] transition hover:bg-[#ffd98a] active:scale-[0.98] disabled:opacity-40 disabled:shadow-none',
  ghost:
    'inline-flex items-center justify-center gap-2 rounded-full border border-seam bg-velvet-2/60 px-4 py-2 text-sm font-medium text-paper transition hover:border-faint hover:bg-velvet-3 active:scale-[0.98] disabled:opacity-40',
  icon: 'inline-grid size-9 place-items-center rounded-full text-paper/85 transition hover:bg-white/10 hover:text-paper active:scale-95 disabled:opacity-35',
  chip: 'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-seam bg-velvet-2 px-3 py-1 text-xs font-medium text-dim transition hover:text-paper',
  chipOn: 'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-bulb/60 bg-bulb/15 px-3 py-1 text-xs font-semibold text-bulb',
};

export const input =
  'w-full rounded-xl border border-seam bg-ink/60 px-3.5 py-2.5 text-sm text-paper placeholder:text-faint outline-none transition focus:border-bulb/70 focus:bg-ink';

// ─── Avatar ──────────────────────────────────────────────────────────────────
export function Avatar({ m, size = 36, ring, className }: { m: Pick<Member, 'avatar' | 'color' | 'name'>; size?: number; ring?: string; className?: string }) {
  return (
    <span
      title={m.name}
      className={cx('relative inline-grid shrink-0 place-items-center rounded-full', className)}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.5,
        background: `radial-gradient(circle at 30% 25%, color-mix(in oklab, ${m.color} 70%, white), ${m.color} 60%, color-mix(in oklab, ${m.color} 60%, black))`,
        boxShadow: ring ? `0 0 0 2px var(--color-ink), 0 0 0 4px ${ring}` : undefined,
      }}
    >
      <span className="leading-none drop-shadow-[0_1px_1px_rgba(0,0,0,.35)]">{m.avatar}</span>
    </span>
  );
}

// ─── Poster (with a typographic fallback for posterless titles) ─────────────
export function Poster({ movie, className, onClick, children }: { movie: Pick<MovieHit, 'title' | 'poster' | 'year'>; className?: string; onClick?: () => void; children?: ReactNode }) {
  const hue = titleHue(movie.title);
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx('group relative block aspect-[2/3] overflow-hidden rounded-xl bg-velvet-2 text-left ring-1 ring-white/5 transition', onClick && 'hover:-translate-y-1 hover:ring-bulb/50', className)}
    >
      <div
        className="absolute inset-0 flex flex-col justify-end p-3"
        style={{ background: `linear-gradient(160deg, hsl(${hue} 45% 32%), hsl(${(hue + 50) % 360} 50% 12%))` }}
      >
        <div className="font-serif text-lg leading-tight font-semibold text-paper/95 italic">{movie.title}</div>
        {movie.year && <div className="mt-1 font-mono text-[10px] tracking-widest text-paper/60">{movie.year}</div>}
      </div>
      {movie.poster && (
        <img
          src={movie.poster}
          alt=""
          loading="lazy"
          className="absolute inset-0 h-full w-full object-cover transition duration-500 group-hover:scale-[1.04]"
          onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
        />
      )}
      {children}
    </button>
  );
}

// ─── Modal / sheet ───────────────────────────────────────────────────────────
export function Modal({
  open,
  onClose,
  children,
  className,
  label,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  label: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 grid place-items-center bg-black/65 p-3 backdrop-blur-sm sm:p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
          role="dialog"
          aria-modal="true"
          aria-label={label}
        >
          <motion.div
            className={cx('relative max-h-[92dvh] w-full overflow-hidden rounded-3xl border border-seam bg-velvet shadow-2xl', className)}
            initial={{ y: 24, scale: 0.98, opacity: 0 }}
            animate={{ y: 0, scale: 1, opacity: 1 }}
            exit={{ y: 16, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 32 }}
          >
            <button className={cx(btn.icon, 'absolute top-3 right-3 z-10')} onClick={onClose} aria-label="Close">
              <X size={18} />
            </button>
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ─── Toasts ──────────────────────────────────────────────────────────────────
export function Toasts() {
  const toasts = useRoom((s) => s.toasts);
  const dismiss = useRoom((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed bottom-4 left-4 z-[60] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.button
            key={t.id}
            layout
            initial={{ opacity: 0, x: -20, scale: 0.96 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: -20 }}
            onClick={() => dismiss(t.id)}
            className={cx(
              'pointer-events-auto flex items-start gap-3 rounded-2xl border px-4 py-3 text-left text-sm shadow-xl backdrop-blur-md',
              t.tone === 'success' && 'border-ok/30 bg-[#16241f]/90',
              t.tone === 'warn' && 'border-bulb/35 bg-[#2a2016]/90',
              t.tone === 'error' && 'border-alarm/40 bg-[#2a1418]/90',
              t.tone === 'info' && 'border-seam bg-velvet-2/90',
            )}
          >
            {t.icon && <span className="text-base leading-5">{t.icon}</span>}
            <span className="leading-5 text-paper/90">{t.text}</span>
          </motion.button>
        ))}
      </AnimatePresence>
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded-md border border-seam bg-ink px-1.5 py-0.5 font-mono text-[10px] text-dim">{children}</kbd>;
}

export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('font-mono text-[10px] font-semibold tracking-[0.18em] text-faint uppercase', className)}>{children}</div>;
}
