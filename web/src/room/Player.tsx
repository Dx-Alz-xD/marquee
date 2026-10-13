import {
  Clapperboard,
  FileVideo,
  Gauge,
  Maximize,
  Minimize,
  Pause,
  PenLine,
  Play,
  Radio,
  RotateCcw,
  RotateCw,
  Search,
  SkipForward,
  Undo2,
  Volume2,
  VolumeX,
  Wand2,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { HEAT_BIN_SECONDS, type Member } from '@shared/types';
import { fmtTime } from '@shared/util';
import { btn, useSession } from '../components/ui';
import { cx, fingerprintFile, fmtBytes } from '../lib/util';
import { canControl, useRoom } from '../store';
import { CatchUp } from './CatchUp';
import { PointerLayer } from './PointerLayer';
import { AddMediaForm } from './Queue';

export function Player() {
  const { engine } = useSession();
  const hostRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const media = useRoom((s) => s.playback?.media ?? null);
  const [idle, setIdle] = useState(false);
  const [fs, setFs] = useState(false);
  const idleTimer = useRef<number | null>(null);

  useEffect(() => {
    if (hostRef.current) engine.mount(hostRef.current);
  }, [engine]);

  useEffect(() => {
    const on = () => setFs(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);

  const poke = () => {
    setIdle(false);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), 2800);
  };

  const toggleFs = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void boxRef.current?.requestFullscreen?.();
  };

  return (
    <div
      ref={boxRef}
      onMouseMove={poke}
      onMouseLeave={() => setIdle(true)}
      className={cx(
        'group/player relative w-full shrink-0 overflow-hidden bg-black',
        fs ? 'h-full' : 'aspect-video max-h-[calc(100dvh-230px)] rounded-2xl shadow-[0_30px_80px_-30px_#000,0_0_0_1px_#ffffff12]',
        idle && media && 'cursor-none',
      )}
    >
      <div ref={hostRef} className="absolute inset-0" />
      {!media && <EmptyScreen />}
      {media && <div className="absolute inset-0" onClick={() => engine.togglePlay()} onDoubleClick={toggleFs} aria-hidden />}
      <Overlays />
      <Floaters />
      {media && <PointerLayer boxRef={boxRef} />}
      {media && <CatchUp />}
      {media && <Controls visible={!idle} fullscreen={fs} toggleFs={toggleFs} />}
    </div>
  );
}

// ─── Empty state ─────────────────────────────────────────────────────────────
function EmptyScreen() {
  const setUi = useRoom((s) => s.setUi);
  return (
    <div className="absolute inset-0 grid place-items-center overflow-y-auto bg-[radial-gradient(ellipse_at_center,#2a1c2c_0%,#0c080d_70%)] p-4">
      <div className="w-full max-w-lg text-center">
        <div className="font-marquee text-4xl tracking-[0.2em] text-bulb/90 drop-shadow-[0_0_14px_var(--color-bulb)] sm:text-6xl">THE SCREEN IS DARK</div>
        <p className="mt-2 text-sm text-dim">Pick something to watch — everyone here will see it start together.</p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <button className={btn.primary} onClick={() => setUi({ discover: true })}>
            <Search size={16} /> Browse movies
          </button>
          <button className={btn.ghost} onClick={() => setUi({ pick: true })}>
            <Wand2 size={15} /> Can’t decide? Group Pick
          </button>
        </div>
        <div className="mx-auto mt-5 max-w-md text-left">
          <AddMediaForm compact />
        </div>
      </div>
    </div>
  );
}

// ─── Overlays ────────────────────────────────────────────────────────────────
function Overlays() {
  const { engine, client } = useSession();
  const p = useRoom((s) => s.playback);
  const local = useRoom((s) => s.local);
  const members = useRoom((s) => s.members);
  const ctl = useRoom(canControl);
  const upNext = useRoom((s) => s.upNext);
  const playlist = useRoom((s) => s.playlist);
  const votes = useRoom((s) => s.votes);
  const you = useRoom((s) => s.you);
  const media = p?.media;

  return (
    <>
      <Countdown />
      {p?.hold && (
        <Banner tone="bulb">
          <span className="size-3 animate-spin rounded-full border-2 border-bulb border-t-transparent" />
          Waiting for {p.hold.waitingFor.map((id) => members[id]?.name ?? 'someone').join(', ')} to buffer — resuming together
          <HoldBar since={p.hold.since} />
        </Banner>
      )}
      {votes
        .filter((v) => !v.resolved)
        .map((v) => {
          const voted = you && (v.yes.includes(you) || v.no.includes(you));
          return (
            <Banner key={v.id} tone="beam" top={p?.hold ? 64 : 12}>
              🗳 <b>{v.byName}</b> wants to {v.kind === 'seek' ? `jump to ${fmtTime(v.position)}` : v.kind}
              <span className="font-mono text-xs opacity-80">
                {v.yes.length}/{v.needed}
              </span>
              {!voted && (
                <span className="pointer-events-auto flex gap-1">
                  <button className="rounded-full bg-beam px-3 py-0.5 text-xs font-bold text-ink" onClick={() => client.send({ t: 'vote', voteId: v.id, yes: true })}>
                    Yes
                  </button>
                  <button className="rounded-full bg-white/10 px-3 py-0.5 text-xs font-bold" onClick={() => client.send({ t: 'vote', voteId: v.id, yes: false })}>
                    No
                  </button>
                </span>
              )}
            </Banner>
          );
        })}
      {media && local.status === 'loading' && (
        <Center>
          <span className="size-9 animate-spin rounded-full border-[3px] border-bulb border-t-transparent" />
          <span className="mt-3 text-sm text-paper/80">Catching up with the room…</span>
        </Center>
      )}
      {media && local.status === 'error' && (
        <Center>
          <div className="pointer-events-auto max-w-md rounded-2xl border border-alarm/40 bg-ink/90 p-5 text-center">
            <div className="font-semibold text-alarm">This video won’t play on your device</div>
            <p className="mt-1 text-sm text-dim">{local.error}. Everyone else keeps watching — try again or skip it.</p>
            <div className="mt-4 flex justify-center gap-2">
              <button className={btn.ghost} onClick={() => engine.reload()}>
                <RotateCcw size={14} /> Try again
              </button>
              {ctl && (
                <button className={btn.ghost} onClick={() => client.send({ t: 'pl', op: 'next' })}>
                  <SkipForward size={14} /> Skip for everyone
                </button>
              )}
            </div>
          </div>
        </Center>
      )}
      {media?.kind === 'local' && local.status === 'needs-file' && <PickLocalFile />}
      {local.blocked && local.muted && (
        <button
          className="absolute top-3 left-3 z-20 inline-flex items-center gap-2 rounded-full bg-bulb px-4 py-2 text-sm font-bold text-ink shadow-lg"
          onClick={() => engine.setMuted(false)}
        >
          <VolumeX size={16} /> Your browser muted autoplay — tap to unmute
        </button>
      )}
      {local.detour && <DetourPill />}
      <AnimatePresence>
        {upNext && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="absolute right-4 bottom-20 z-20 w-72 rounded-2xl border border-seam bg-ink/90 p-4 backdrop-blur"
          >
            <UpNextCard itemTitle={playlist.find((i) => i.id === upNext.itemId)?.media.title ?? 'Next item'} at={upNext.at} canAct={ctl} />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function Banner({ children, tone, top = 12 }: { children: React.ReactNode; tone: 'bulb' | 'beam'; top?: number }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 z-20 flex justify-center px-3" style={{ top }}>
      <div
        className={cx(
          'relative flex items-center gap-2.5 overflow-hidden rounded-full border px-4 py-2 text-sm backdrop-blur-md',
          tone === 'bulb' ? 'border-bulb/40 bg-[#2a2016]/90 text-bulb' : 'border-beam/40 bg-[#132330]/90 text-beam',
        )}
      >
        {children}
      </div>
    </div>
  );
}

function HoldBar({ since }: { since: number }) {
  const { client } = useSession();
  const [pct, setPct] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setPct(Math.min(100, ((client.serverNow() - since) / 10000) * 100)), 100);
    return () => clearInterval(t);
  }, [since, client]);
  return <span className="absolute bottom-0 left-0 h-0.5 bg-bulb" style={{ width: `${pct}%` }} />;
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center bg-black/40 p-4">{children}</div>;
}

/** Academy-leader countdown. Rendered from the shared anchor, so it ticks identically on every screen. */
function Countdown() {
  const { client } = useSession();
  const p = useRoom((s) => s.playback);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!p || p.status !== 'playing' || p.at <= client.serverNow()) return;
    let raf = 0;
    const loop = () => {
      setTick((x) => x + 1);
      if (client.serverNow() < p.at + 50) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [p, client]);
  // Always read the live clock here: a remembered "now" goes stale between countdowns.
  const now = client.serverNow();
  if (!p || p.status !== 'playing' || p.at <= now) return null;
  const ms = p.at - now;
  const n = Math.ceil(ms / 1000);
  const sweep = (1 - (ms % 1000) / 1000) * 360;
  const resume = p.cause === 'resume';
  return (
    <div className="pointer-events-none absolute inset-0 z-30 grid place-items-center bg-black/55">
      <div className="flex flex-col items-center">
        <div
          className={cx('leader leader-cross relative grid place-items-center rounded-full', resume ? 'size-[18vmin] min-h-24 min-w-24' : 'size-[34vmin] min-h-40 min-w-40 max-h-80 max-w-80')}
          style={{ ['--sweep' as string]: `${sweep}deg` }}
        >
          <span className="relative z-10 font-marquee text-[min(22vmin,12rem)] leading-none text-[#1a1016]" style={{ fontSize: resume ? '11vmin' : undefined }}>
            {n}
          </span>
        </div>
        <div className="mt-4 font-mono text-xs tracking-[0.3em] text-paper/80 uppercase">{resume ? 'Resuming together' : 'Everyone starts on the same frame'}</div>
      </div>
    </div>
  );
}

function DetourPill() {
  const { engine } = useSession();
  const [delta, setDelta] = useState(0);
  useEffect(() => {
    const t = setInterval(() => {
      const room = engine.roomPosition();
      if (room != null) setDelta(engine.displayTime() - room);
    }, 250);
    return () => clearInterval(t);
  }, [engine]);
  return (
    <div className="absolute top-3 right-3 z-20 flex items-center gap-2">
      <span className="rounded-full bg-ink/80 px-3 py-1.5 font-mono text-[11px] text-dim backdrop-blur">
        Personal detour · {Math.abs(delta) < 1 ? 'with the room' : `${fmtTime(Math.abs(delta))} ${delta < 0 ? 'behind' : 'ahead'}`}
      </span>
      <button onClick={() => engine.endDetour()} className="inline-flex items-center gap-1.5 rounded-full bg-alarm px-3 py-1.5 text-xs font-bold tracking-wider text-white shadow-[0_0_20px_-4px_var(--color-alarm)]">
        <Radio size={13} /> GO LIVE
      </button>
    </div>
  );
}

function UpNextCard({ itemTitle, at, canAct }: { itemTitle: string; at: number; canAct: boolean }) {
  const { client } = useSession();
  const [left, setLeft] = useState(Math.ceil((at - Date.now()) / 1000));
  useEffect(() => {
    const t = setInterval(() => setLeft(Math.max(0, Math.ceil((at - Date.now()) / 1000))), 250);
    return () => clearInterval(t);
  }, [at]);
  return (
    <>
      <div className="font-mono text-[10px] tracking-[0.2em] text-faint uppercase">Up next in {left}s</div>
      <div className="mt-1 line-clamp-2 font-serif text-lg leading-snug">{itemTitle}</div>
      {canAct && (
        <div className="mt-3 flex gap-2">
          <button className={cx(btn.primary, 'px-3 py-1.5 text-xs')} onClick={() => client.send({ t: 'pl', op: 'next' })}>
            Play now
          </button>
          <button className={cx(btn.ghost, 'px-3 py-1.5 text-xs')} onClick={() => client.send({ t: 'pl', op: 'cancelNext' })}>
            Cancel
          </button>
        </div>
      )}
    </>
  );
}

// ─── Local-file mode: everyone supplies their own copy, matched by fingerprint ─
function PickLocalFile() {
  const { engine } = useSession();
  const media = useRoom((s) => s.playback?.media);
  const members = useRoom((s) => s.members);
  const [busy, setBusy] = useState(false);
  const [mismatch, setMismatch] = useState<{ file: File; fp: string } | null>(null);
  if (!media?.local) return null;
  const want = media.local;
  const matched = Object.values(members).filter((m) => m.online && m.localFingerprint === want.fingerprint);

  const accept = (file: File, fp: string, force: boolean) => {
    const prev = useRoom.getState().localFile;
    if (prev) URL.revokeObjectURL(prev.url);
    useRoom.setState({ localFile: { name: file.name, size: file.size, fingerprint: fp, url: URL.createObjectURL(file), acceptedFor: force ? media.id : null } });
    setMismatch(null);
    engine.reload();
  };

  const onPick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    const fp = await fingerprintFile(file);
    setBusy(false);
    if (fp === want.fingerprint) accept(file, fp, false);
    else setMismatch({ file, fp });
  };

  return (
    <div className="absolute inset-0 z-20 grid place-items-center bg-black/70 p-4">
      <label
        className="flex w-full max-w-md cursor-pointer flex-col items-center rounded-3xl border-2 border-dashed border-bulb/40 bg-velvet/90 p-6 text-center transition hover:border-bulb"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void onPick(e.dataTransfer.files[0]);
        }}
      >
        <FileVideo size={34} className="text-bulb" />
        <div className="mt-3 font-serif text-xl">Pick your copy of the file</div>
        <div className="mt-1 font-mono text-xs break-all text-dim">
          {want.name} · {fmtBytes(want.size)}
        </div>
        <p className="mt-3 text-xs text-dim">Nothing is uploaded — your browser plays your own file and Marquee keeps it in sync with everyone else’s.</p>
        <span className={cx(btn.primary, 'mt-4')}>{busy ? 'Checking file…' : 'Choose file'}</span>
        <input type="file" accept="video/*,.mkv" className="hidden" onChange={(e) => void onPick(e.target.files?.[0])} />
        <div className="mt-4 text-xs text-faint">
          {matched.length} of {Object.values(members).filter((m) => m.online).length} ready: {matched.map((m) => m.name).join(', ') || '—'}
        </div>
        {mismatch && (
          <div className="mt-4 rounded-xl border border-bulb/40 bg-bulb/10 p-3 text-left text-xs text-bulb" onClick={(e) => e.preventDefault()}>
            “{mismatch.file.name}” isn’t the same file (different size or content), so scenes may not line up.
            <div className="mt-2 flex gap-2">
              <button className="rounded-full bg-bulb px-3 py-1 font-bold text-ink" onClick={() => accept(mismatch.file, mismatch.fp, true)}>
                Use it anyway
              </button>
              <button className="rounded-full bg-white/10 px-3 py-1 font-bold text-paper" onClick={() => setMismatch(null)}>
                Pick another
              </button>
            </div>
          </div>
        )}
      </label>
    </div>
  );
}

// ─── Reactions floating up from each person's seat ───────────────────────────
function Floaters() {
  const floaters = useRoom((s) => s.floaters);
  const combos = useRoom((s) => s.combos);
  const members = useRoom((s) => s.members);
  const seatX = useMemo(() => {
    const sorted = Object.values(members).sort((a, b) => a.seat - b.seat);
    const map: Record<string, number> = {};
    sorted.forEach((m, i) => (map[m.id] = ((i + 0.5) / sorted.length) * 100));
    return map;
  }, [members]);
  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      {floaters.map((f) => (
        <span
          key={f.id}
          className="floater absolute bottom-16 text-4xl drop-shadow-[0_4px_10px_rgba(0,0,0,.5)]"
          style={{ left: `${seatX[f.memberId] ?? 50}%`, ['--sway' as string]: `${f.sway}px` }}
        >
          {f.emoji}
        </span>
      ))}
      <AnimatePresence>
        {combos.map((c) => (
          <motion.div
            key={c.id}
            initial={{ scale: 0.4, opacity: 0, rotate: -8 }}
            animate={{ scale: 1, opacity: 1, rotate: 0 }}
            exit={{ scale: 1.4, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 400, damping: 14 }}
            className="absolute inset-0 grid place-items-center"
          >
            <div className="flex items-center gap-3 rounded-full bg-ink/70 px-6 py-3 backdrop-blur">
              <span className="text-6xl">{c.emoji}</span>
              <span className="font-marquee text-6xl tracking-wider text-bulb drop-shadow-[0_0_14px_var(--color-bulb)]">×{c.count} COMBO</span>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

// ─── Controls + heatmap seek bar ─────────────────────────────────────────────
function Controls({ visible, fullscreen, toggleFs }: { visible: boolean; fullscreen: boolean; toggleFs: () => void }) {
  const { engine } = useSession();
  const p = useRoom((s) => s.playback);
  const local = useRoom((s) => s.local);
  const ctl = useRoom(canControl);
  const mode = useRoom((s) => s.settings?.controlMode);
  const heat = useRoom((s) => (s.playback?.media ? s.heatmap[s.playback.media.id] : undefined));
  const [t, setT] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const { client } = useSession();
  const hovers = useRoom((s) => s.hovers);
  const members = useRoom((s) => s.members);
  const lastHoverSent = useRef(0);
  const sendHover = (time: number | null) => {
    const now = performance.now();
    if (time != null && now - lastHoverSent.current < 120) return;
    lastHoverSent.current = time == null ? 0 : now;
    client.send({ t: 'hover', time });
  };

  useEffect(() => {
    let raf = 0;
    let last = 0;
    const loop = (ts: number) => {
      if (ts - last > 90) {
        setT(engine.displayTime());
        last = ts;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  const dur = local.duration ?? p?.media?.duration ?? 0;
  const playing = local.detour ? !(engine.videoElement()?.paused ?? true) : p?.status === 'playing' && !p.hold;
  const shown = drag ?? t;
  const pct = dur ? Math.min(100, (shown / dur) * 100) : 0;
  const locked = !ctl && mode === 'host' && !local.detour;

  const posFromEvent = (clientX: number) => {
    const r = barRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * dur;
  };

  const heatPath = useMemo(() => {
    if (!heat?.length || !dur) return null;
    const bins = heat.map((_, i) => (heat[i - 1] ?? 0) * 0.25 + heat[i] * 0.5 + (heat[i + 1] ?? 0) * 0.25);
    const max = Math.max(...bins, 1);
    const pts = bins.map((v, i) => `${(((i + 0.5) * HEAT_BIN_SECONDS) / dur) * 100},${100 - (v / max) * 100}`);
    return `M0,100 L${pts.join(' L')} L100,100 Z`;
  }, [heat, dur]);

  const drift = local.drift;
  const driftTone = drift == null ? 'text-faint' : Math.abs(drift) < 80 ? 'text-beam' : Math.abs(drift) < 500 ? 'text-bulb' : 'text-alarm';

  return (
    <div
      className={cx(
        'absolute inset-x-0 bottom-0 z-30 bg-gradient-to-t from-black/90 via-black/50 to-transparent px-2 pt-8 pb-1.5 transition-opacity duration-300 sm:px-4 sm:pt-14 sm:pb-2.5',
        visible || !playing ? 'opacity-100' : 'opacity-0 focus-within:opacity-100',
      )}
    >
      {/* seek bar */}
      <div
        ref={barRef}
        className={cx('group/bar relative h-7 touch-none', locked ? 'cursor-not-allowed' : 'cursor-pointer')}
        onPointerMove={(e) => {
          if (!dur) return;
          const time = posFromEvent(e.clientX);
          setHover(time);
          sendHover(time);
        }}
        onPointerLeave={() => {
          setHover(null);
          sendHover(null);
        }}
        onPointerDown={(e) => {
          if (!dur || locked) return;
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          setDrag(posFromEvent(e.clientX));
        }}
        onPointerUp={(e) => {
          if (drag == null) return;
          const target = posFromEvent(e.clientX);
          setDrag(null);
          engine.command('seek', target);
        }}
        onPointerCancel={() => setDrag(null)}
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(dur)}
        aria-valuenow={Math.round(shown)}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') engine.command('seek', Math.max(0, t - 5));
          if (e.key === 'ArrowRight') engine.command('seek', t + 5);
        }}
      >
        {heatPath && (
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="pointer-events-none absolute inset-x-0 bottom-3 h-5 w-full opacity-80" aria-hidden>
            <defs>
              <linearGradient id="heat" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="var(--color-bulb)" stopOpacity="0.9" />
                <stop offset="1" stopColor="var(--color-bulb)" stopOpacity="0.05" />
              </linearGradient>
            </defs>
            <path d={heatPath} fill="url(#heat)" />
          </svg>
        )}
        <div className="absolute inset-x-0 bottom-2 h-1 rounded-full bg-white/20 transition-all group-hover/bar:h-1.5">
          <div className="h-full rounded-full bg-bulb" style={{ width: `${pct}%` }} />
        </div>
        <div className="absolute bottom-[3px] size-3.5 -translate-x-1/2 rounded-full bg-bulb opacity-0 shadow-[0_0_10px_var(--color-bulb)] transition group-hover/bar:opacity-100" style={{ left: `${pct}%` }} />
        {hover != null && (
          <div className="pointer-events-none absolute -top-5 -translate-x-1/2 rounded bg-ink/90 px-1.5 py-0.5 font-mono text-[10px]" style={{ left: `${(hover / dur) * 100}%` }}>
            {fmtTime(hover)}
          </div>
        )}
        {dur > 0 &&
          Object.entries(hovers)
            .filter(([id, h]) => members[id] && Date.now() - h.at < 3000)
            .map(([id, h]) => (
              <GhostMarker key={id} name={members[id].name} avatar={members[id].avatar} color={members[id].color} left={(h.time / dur) * 100} time={h.time} />
            ))}
      </div>

      <div className="flex items-center gap-0.5 sm:gap-1">
        <button className={btn.icon} onClick={() => engine.togglePlay()} aria-label={playing ? 'Pause' : 'Play'} title={locked ? 'Only the host can control playback' : playing ? 'Pause (Space)' : 'Play (Space)'}>
          {playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
        </button>
        <button className={cx(btn.icon, 'max-sm:hidden')} onClick={() => engine.command('seek', Math.max(0, t - 10))} aria-label="Back 10 seconds" title="Back 10 s (←)">
          <RotateCcw size={17} />
        </button>
        <button className={cx(btn.icon, 'max-sm:hidden')} onClick={() => engine.command('seek', t + 10)} aria-label="Forward 10 seconds" title="Forward 10 s (→)">
          <RotateCw size={17} />
        </button>
        <VolumeControl />
        <span className="ml-1 font-mono text-[11px] whitespace-nowrap text-paper/85 tabular-nums sm:text-xs">
          {fmtTime(shown)} <span className="text-paper/45">/ {fmtTime(dur || null)}</span>
        </span>
        {locked && <span className="ml-2 hidden rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-dim md:inline">host has the remote</span>}
        {mode === 'democracy' && !ctl && <span className="ml-2 hidden rounded-full bg-beam/15 px-2 py-0.5 text-[10px] text-beam md:inline">your presses start a vote</span>}
        <div className="ml-auto flex items-center gap-0.5 sm:gap-1">
          <span className={cx('hidden items-center gap-1 rounded-full bg-black/40 px-2.5 py-1 font-mono text-[11px] sm:inline-flex', driftTone)} title="Your offset from the room’s shared timeline">
            {local.detour ? 'detour' : drift == null ? 'sync —' : `${drift >= 0 ? '+' : ''}${drift} ms`}
            {Math.abs(local.rate - local.baseRate) > 0.001 && !local.detour && <span className="text-[10px] opacity-75">· {local.rate.toFixed(2)}×</span>}
          </span>
          {ctl && !local.detour && (
            <button className={btn.icon} onClick={() => engine.countdown()} aria-label="Start with a 3-2-1 countdown" title="Start for everyone with a 3-2-1 countdown">
              <Clapperboard size={17} />
            </button>
          )}
          <SpeedMenu canSet={ctl} />
          <DrawToggle />
          <button
            className={cx(btn.icon, local.detour && 'bg-alarm/20 text-alarm')}
            onClick={() => (local.detour ? engine.endDetour() : engine.startDetour())}
            aria-label={local.detour ? 'Go live' : 'Personal detour'}
            title={local.detour ? 'Rejoin the room (GO LIVE)' : 'Personal detour — rewatch a moment without affecting anyone'}
          >
            <Undo2 size={17} />
          </button>
          <button className={btn.icon} onClick={toggleFs} aria-label="Fullscreen" title="Fullscreen">
            {fullscreen ? <Minimize size={17} /> : <Maximize size={17} />}
          </button>
        </div>
      </div>
    </div>
  );
}

function VolumeControl() {
  const { engine } = useSession();
  const volume = useRoom((s) => s.local.volume);
  const muted = useRoom((s) => s.local.muted);
  return (
    <div className="group/vol flex items-center">
      <button className={btn.icon} onClick={() => engine.setMuted(!muted)} aria-label={muted ? 'Unmute' : 'Mute'}>
        {muted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.02}
        value={muted ? 0 : volume}
        onChange={(e) => {
          engine.setVolume(Number(e.target.value));
          if (muted) engine.setMuted(false);
        }}
        aria-label="Volume"
        className="w-0 accent-[var(--color-bulb)] opacity-0 transition-all group-hover/vol:w-20 group-hover/vol:opacity-100 focus:w-20 focus:opacity-100"
      />
    </div>
  );
}

export type { Member };

/** Where someone else is hovering on the timeline ("Ben is eyeing 1:02:10"). */
function GhostMarker({ name, avatar, color, left, time }: { name: string; avatar: string; color: string; left: number; time: number }) {
  return (
    <div className="group/ghost pointer-events-auto absolute bottom-3.5 z-10 -translate-x-1/2 transition-[left] duration-150 ease-out" style={{ left: `${Math.min(100, Math.max(0, left))}%` }}>
      <div className="grid size-5 place-items-center rounded-full text-[11px] shadow-lg ring-2" style={{ background: color, ['--tw-ring-color' as string]: 'rgba(0,0,0,.6)' }} title={`${name} is eyeing ${fmtTime(time)}`}>
        {avatar}
      </div>
      <div className="pointer-events-none absolute bottom-6 left-1/2 hidden -translate-x-1/2 rounded bg-ink/90 px-1.5 py-0.5 text-[10px] whitespace-nowrap group-hover/ghost:block">
        {name} · {fmtTime(time)}
      </div>
      <div className="mx-auto h-2 w-px" style={{ background: color }} />
    </div>
  );
}

const SPEEDS = [0.75, 1, 1.25, 1.5];

/** Synced speed: changes it for everyone. Others see the current speed as a badge. */
function SpeedMenu({ canSet }: { canSet: boolean }) {
  const { engine } = useSession();
  const rate = useRoom((s) => s.playback?.rate ?? 1);
  const [open, setOpen] = useState(false);
  if (!canSet && rate === 1) return null;
  return (
    <div className="relative">
      <button
        className={cx(btn.icon, 'w-auto px-2 font-mono text-[11px]', rate !== 1 && 'text-bulb')}
        onClick={() => canSet && setOpen(!open)}
        aria-label="Playback speed for everyone"
        title={canSet ? 'Playback speed (for everyone)' : `Room speed ${rate}×`}
      >
        {rate === 1 ? <Gauge size={17} /> : `${rate}×`}
      </button>
      {open && (
        <div className="absolute right-0 bottom-11 z-40 w-36 rounded-xl border border-seam bg-velvet-2 p-1 shadow-2xl">
          <div className="px-2 py-1 text-[10px] tracking-wider text-faint uppercase">Speed for everyone</div>
          {SPEEDS.map((r) => (
            <button
              key={r}
              onClick={() => {
                engine.speed(r);
                setOpen(false);
              }}
              className={cx('block w-full rounded-lg px-2 py-1.5 text-left font-mono text-xs hover:bg-white/5', r === rate && 'text-bulb')}
            >
              {r === 1 ? '1× normal' : `${r}×`}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Touch-friendly draw mode (desktop users can just hold Shift). */
function DrawToggle() {
  const draw = useRoom((s) => s.ui.draw);
  const setUi = useRoom((s) => s.setUi);
  return (
    <button
      className={cx(btn.icon, draw && 'bg-bulb/20 text-bulb')}
      onClick={() => setUi({ draw: !draw })}
      aria-label="Draw on screen"
      aria-pressed={draw}
      title="Draw / point on everyone's screen (or hold Shift)"
    >
      <PenLine size={17} />
    </button>
  );
}
