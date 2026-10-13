// Members as seats in a theater row. Seat ring = sync health (projector cyan =
// in sync, amber = correcting, red = off); status glyphs for buffering, away,
// detour, reconnecting. Reactions rise from these seats over the screen.
import { Crown, Headphones, Mic, MoreHorizontal, Star } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useMemo, useState } from 'react';
import type { Member, MemberTelemetry } from '@shared/types';
import { Avatar, useSession } from '../components/ui';
import { cx } from '../lib/util';
import { useRoom } from '../store';

export function syncTone(m: Member, t?: MemberTelemetry): { color: string; label: string } {
  if (!m.online) return { color: '#6f6072', label: 'reconnecting…' };
  switch (m.player) {
    case 'buffering':
      return { color: 'var(--color-bulb)', label: 'buffering' };
    case 'loading':
      return { color: 'var(--color-faint)', label: 'loading' };
    case 'error':
      return { color: 'var(--color-alarm)', label: 'can’t play this video' };
    case 'needs-file':
      return { color: 'var(--color-bulb)', label: 'picking their file' };
    case 'detour':
      return { color: '#c084fc', label: 'on a personal detour' };
    case 'blocked':
      return { color: 'var(--color-bulb)', label: 'autoplay blocked' };
    case 'idle':
      return { color: 'var(--color-faint)', label: 'idle' };
  }
  const d = t?.drift;
  if (d == null) return { color: 'var(--color-beam)', label: 'in sync' };
  const a = Math.abs(d);
  if (a < 80) return { color: 'var(--color-beam)', label: `in sync · ${Math.round(a)} ms` };
  if (a < 500) return { color: 'var(--color-bulb)', label: `correcting · ${Math.round(d)} ms` };
  return { color: 'var(--color-alarm)', label: `out of sync · ${(d / 1000).toFixed(1)} s` };
}

export function TheaterRow() {
  const members = useRoom((s) => s.members);
  const telemetry = useRoom((s) => s.telemetry);
  const you = useRoom((s) => s.you);
  const sorted = useMemo(() => Object.values(members).sort((a, b) => a.seat - b.seat), [members]);
  const [menu, setMenu] = useState<string | null>(null);

  return (
    <section aria-label="Who's watching" className="relative rounded-3xl border border-seam bg-[linear-gradient(180deg,#1d1420,#150e17)] px-3 pt-4 pb-3">
      <div className="no-scrollbar flex items-end justify-start gap-1 overflow-x-auto pb-1 sm:justify-center">
        {sorted.map((m, i) => (
          <Seat key={m.id} m={m} t={telemetry[m.id]} you={m.id === you} tilt={(i - (sorted.length - 1) / 2) * 1.2} onToggle={() => setMenu(menu === m.id ? null : m.id)} />
        ))}
      </div>
      <AnimatePresence>{menu && members[menu] && <SeatMenu key={menu} m={members[menu]} you={menu === you} onClose={() => setMenu(null)} />}</AnimatePresence>
    </section>
  );
}

function Seat({ m, t, you, tilt, onToggle }: { m: Member; t?: MemberTelemetry; you: boolean; tilt: number; onToggle: () => void }) {
  const tone = syncTone(m, t);
  const speaking = useRoom((s) => !!s.speaking[m.id] && m.voice === 'talk');
  return (
    <div className="relative flex w-[76px] shrink-0 flex-col items-center" style={{ transform: `rotate(${tilt}deg)` }}>
      <button onClick={onToggle} className={cx('group relative flex flex-col items-center transition', !m.online && 'opacity-45')} aria-label={`${m.name}: ${tone.label}${speaking ? ', talking' : ''}`} title={`${m.name} — ${tone.label}${speaking ? ' · talking' : ''}`}>
        <div className="relative">
          {speaking && <span className="absolute -inset-1.5 animate-ping rounded-full bg-bulb/40" aria-hidden />}
          <Avatar m={m} size={44} ring={speaking ? 'var(--color-bulb)' : tone.color} className={cx('relative transition-transform', m.player === 'buffering' && 'pulse-ring', speaking && 'scale-110')} />
          {m.role === 'host' && <Crown size={16} className="absolute -top-3 left-1/2 -translate-x-1/2 fill-bulb text-bulb drop-shadow" />}
          {m.role === 'cohost' && <Star size={13} className="absolute -top-2.5 left-1/2 -translate-x-1/2 fill-bulb/70 text-bulb/70" />}
          {m.voice !== 'off' && (
            <span className={cx('absolute -bottom-1 -left-1 grid size-5 place-items-center rounded-full bg-ink ring-1', speaking ? 'text-bulb ring-bulb' : 'text-dim ring-seam')} title={m.voice === 'talk' ? 'In voice' : 'Listening in voice'}>
              {m.voice === 'talk' ? <Mic size={10} /> : <Headphones size={10} />}
            </span>
          )}
          <StatusGlyph m={m} />
        </div>
        {/* the seat back */}
        <div className="-mt-3 h-7 w-[62px] rounded-t-[18px] rounded-b-md bg-[linear-gradient(180deg,#6b2338,#3e1322)] shadow-[inset_0_2px_0_#8a3049,inset_0_-6px_10px_#0006]" />
        <div className="mt-1 max-w-[74px] truncate text-[11px] font-medium text-paper/85">
          {m.name}
          {you && <span className="text-faint"> (you)</span>}
        </div>
        <div className="font-mono text-[9px]" style={{ color: tone.color }}>
          {m.player === 'ready' && t?.drift != null ? `${Math.round(t.drift)}ms` : tone.label.split(' ·')[0]}
        </div>
      </button>
    </div>
  );
}

function StatusGlyph({ m }: { m: Member }) {
  const g = !m.online ? '📡' : m.away ? '🌙' : m.player === 'buffering' ? '⏳' : m.player === 'detour' ? '↩' : m.player === 'needs-file' ? '📁' : m.player === 'error' ? '⚠' : m.device === 'mobile' ? '📱' : null;
  if (!g) return null;
  return <span className="absolute -right-1 -bottom-1 grid size-5 place-items-center rounded-full bg-ink text-[11px] ring-1 ring-seam">{g}</span>;
}

function SeatMenu({ m, you, onClose }: { m: Member; you: boolean; onClose: () => void }) {
  const { client } = useSession();
  const me = useRoom((s) => (s.you ? s.members[s.you] : null));
  const chaos = useRoom((s) => s.chaosEnabled);
  const isHost = me?.role === 'host';
  const isMod = me?.role !== 'member';
  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };
  const items: [string, () => void][] = [];
  if (!you && isHost) {
    items.push([`Hand the remote to ${m.name}`, () => client.send({ t: 'role', op: 'transfer', target: m.id })]);
    if (m.role === 'member') items.push(['Make co-host', () => client.send({ t: 'role', op: 'cohost', target: m.id })]);
    if (m.role === 'cohost') items.push(['Remove co-host', () => client.send({ t: 'role', op: 'demote', target: m.id })]);
  }
  if (!you && isMod && m.role !== 'host') items.push(['Remove from room', () => client.send({ t: 'role', op: 'kick', target: m.id })]);
  if (isHost && chaos) items.push(['🧪 Open in Sync Lab', () => useRoom.getState().setUi({ lab: true })]);
  return (
    <motion.div
      initial={{ opacity: 0, y: 6, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0 }}
      className="absolute bottom-full left-1/2 z-40 mb-2 w-60 -translate-x-1/2 rounded-2xl border border-seam bg-velvet-2 p-1.5 text-left shadow-2xl"
    >
      <div className="flex items-center gap-2 px-2.5 py-2 text-xs text-dim">
        <MoreHorizontal size={14} /> {m.name}
        {m.role !== 'member' && <span className="ml-auto rounded bg-bulb/15 px-1.5 text-[10px] text-bulb">{m.role}</span>}
      </div>
      {items.length === 0 && <div className="px-2.5 pb-2 text-xs text-faint">No actions available</div>}
      {items.map(([label, fn]) => (
        <button key={label} onClick={act(fn)} className="block w-full rounded-xl px-2.5 py-2 text-left text-sm hover:bg-white/5">
          {label}
        </button>
      ))}
    </motion.div>
  );
}
