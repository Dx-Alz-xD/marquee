// Laser pointer & live drawing on the shared screen.
//   • Hold Shift and move: a glowing laser dot (with a short comet trail) on everyone's screen.
//   • Shift + drag (or the ✏️ toggle on touch screens): draw strokes that fade after a few seconds.
// Coordinates are normalised to the player box, so they land on the same spot on every screen size.
// Remote points never touch React state: they go straight into a canvas render loop.
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { ServerMsg } from '@shared/protocol';
import { useSession } from '../components/ui';
import { useRoom } from '../store';

interface Pt {
  x: number;
  y: number;
  t: number;
}
interface Ink {
  memberId: string;
  pts: Pt[];
  done: boolean;
  doneAt: number;
}

const LASER_TRAIL_MS = 650;
const INK_HOLD_MS = 3500;
const INK_FADE_MS = 900;
const SEND_EVERY_MS = 33; // ~30 Hz

export function PointerLayer({ boxRef }: { boxRef: RefObject<HTMLDivElement | null> }) {
  const { client } = useSession();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawToggle = useRoom((s) => s.ui.draw);
  const [shift, setShift] = useState(false);
  const lasers = useRef(new Map<string, Pt[]>());
  const inks = useRef<Ink[]>([]);
  const lastSent = useRef(0);
  const drawing = useRef(false);

  // Remote pointer frames → buffers (no React re-render).
  useEffect(() => {
    const onMsg = (msg: ServerMsg) => {
      if (msg.t !== 'pointer') return;
      ingest(msg.memberId, msg.x, msg.y, msg.mode, msg.end);
    };
    client.onMessage(onMsg);
    return () => client.offMessage(onMsg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  function ingest(memberId: string, x: number, y: number, mode: 'laser' | 'draw', end: boolean) {
    const t = performance.now();
    if (mode === 'laser') {
      const trail = lasers.current.get(memberId) ?? [];
      trail.push({ x, y, t });
      lasers.current.set(memberId, trail.slice(-40));
      return;
    }
    let ink = [...inks.current].reverse().find((i) => i.memberId === memberId && !i.done);
    if (!ink) {
      ink = { memberId, pts: [], done: false, doneAt: 0 };
      inks.current.push(ink);
      if (inks.current.length > 60) inks.current.shift();
    }
    ink.pts.push({ x, y, t });
    if (end) {
      ink.done = true;
      ink.doneAt = t;
    }
  }

  // Shift tracking (desktop laser).
  useEffect(() => {
    const down = (e: KeyboardEvent) => e.key === 'Shift' && !(e.target as HTMLElement).closest('input, textarea') && setShift(true);
    const up = (e: KeyboardEvent) => e.key === 'Shift' && setShift(false);
    const blur = () => setShift(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  const active = shift || drawToggle;

  // Local input on the player box.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const you = () => useRoom.getState().you ?? 'me';
    const norm = (e: PointerEvent) => {
      const r = box.getBoundingClientRect();
      return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
    };
    const send = (x: number, y: number, mode: 'laser' | 'draw', end = false, force = false) => {
      const t = performance.now();
      if (!force && t - lastSent.current < SEND_EVERY_MS) return;
      lastSent.current = t;
      client.send({ t: 'pointer', x, y, mode, end });
    };
    const move = (e: PointerEvent) => {
      const isActive = e.shiftKey || useRoom.getState().ui.draw;
      if (!isActive && !drawing.current) return;
      const { x, y } = norm(e);
      const mode = drawing.current ? 'draw' : 'laser';
      ingest(you(), x, y, mode, false);
      send(x, y, mode);
    };
    const downH = (e: PointerEvent) => {
      if (!(e.shiftKey || useRoom.getState().ui.draw)) return;
      if ((e.target as HTMLElement).closest('button, input, [role="slider"]')) return;
      e.preventDefault();
      e.stopPropagation();
      drawing.current = true;
      const { x, y } = norm(e);
      ingest(you(), x, y, 'draw', false);
      send(x, y, 'draw', false, true);
    };
    const upH = (e: PointerEvent) => {
      if (!drawing.current) return;
      drawing.current = false;
      const { x, y } = norm(e);
      ingest(you(), x, y, 'draw', true);
      send(x, y, 'draw', true, true);
    };
    box.addEventListener('pointermove', move);
    box.addEventListener('pointerdown', downH, { capture: true });
    window.addEventListener('pointerup', upH);
    return () => {
      box.removeEventListener('pointermove', move);
      box.removeEventListener('pointerdown', downH, { capture: true });
      window.removeEventListener('pointerup', upH);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxRef, client]);

  // Render loop.
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = canvasRef.current;
      if (!c) return;
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth;
      const h = c.clientHeight;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      const ctx = c.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const now = performance.now();
      const members = useRoom.getState().members;
      const me = useRoom.getState().you;
      const colorOf = (id: string) => members[id]?.color ?? (id === 'me' ? '#ffcf6e' : '#ffffff');

      // Ink strokes
      inks.current = inks.current.filter((i) => !i.done || now - i.doneAt < INK_HOLD_MS + INK_FADE_MS);
      for (const ink of inks.current) {
        if (ink.pts.length < 1) continue;
        const age = ink.done ? now - ink.doneAt : 0;
        const alpha = age < INK_HOLD_MS ? 1 : Math.max(0, 1 - (age - INK_HOLD_MS) / INK_FADE_MS);
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = colorOf(ink.memberId);
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.shadowColor = colorOf(ink.memberId);
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ink.pts.forEach((p, i) => (i ? ctx.lineTo(p.x * w, p.y * h) : ctx.moveTo(p.x * w, p.y * h)));
        if (ink.pts.length === 1) ctx.lineTo(ink.pts[0].x * w + 0.1, ink.pts[0].y * h);
        ctx.stroke();
      }

      // Laser dots with comet trails + name tags
      for (const [id, trail] of lasers.current) {
        const live = trail.filter((p) => now - p.t < LASER_TRAIL_MS);
        if (!live.length) {
          lasers.current.delete(id);
          continue;
        }
        lasers.current.set(id, live);
        const color = colorOf(id);
        ctx.shadowColor = color;
        for (let i = 1; i < live.length; i++) {
          const a = 1 - (now - live[i].t) / LASER_TRAIL_MS;
          ctx.globalAlpha = a * 0.6;
          ctx.strokeStyle = color;
          ctx.lineWidth = 2 + 5 * a;
          ctx.shadowBlur = 12;
          ctx.beginPath();
          ctx.moveTo(live[i - 1].x * w, live[i - 1].y * h);
          ctx.lineTo(live[i].x * w, live[i].y * h);
          ctx.stroke();
        }
        const head = live[live.length - 1];
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 22;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(head.x * w, head.y * h, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(head.x * w, head.y * h, 2.5, 0, Math.PI * 2);
        ctx.fill();
        const name = id === me || id === 'me' ? 'you' : members[id]?.name ?? '';
        if (name) {
          ctx.font = '600 11px Inter Variable, system-ui, sans-serif';
          const tw = ctx.measureText(name).width;
          const x = Math.min(w - tw - 14, head.x * w + 12);
          const y = Math.max(16, head.y * h - 12);
          ctx.globalAlpha = 0.9;
          ctx.fillStyle = 'rgba(18,13,20,.85)';
          ctx.beginPath();
          ctx.roundRect(x - 6, y - 12, tw + 12, 18, 9);
          ctx.fill();
          ctx.fillStyle = color;
          ctx.fillText(name, x, y + 1);
        }
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <>
      <canvas
        ref={canvasRef}
        className={`absolute inset-0 z-[25] h-full w-full ${active ? 'cursor-crosshair' : 'pointer-events-none'}`}
        style={{ touchAction: active ? 'none' : 'auto' }}
        aria-hidden
      />
      {active && (
        <div className="pointer-events-none absolute top-3 left-1/2 z-[26] -translate-x-1/2 rounded-full bg-ink/80 px-3 py-1 text-[11px] text-paper/80 backdrop-blur">
          {drawToggle ? 'Draw mode — drag to sketch for everyone' : 'Laser on — move to point, drag to draw'}
        </div>
      )}
    </>
  );
}
