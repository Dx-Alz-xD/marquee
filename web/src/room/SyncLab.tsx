// Sync Lab — the reliability story made visible. Live per-member drift, RTT,
// clock offset and correction rate; room-wide propagation percentiles against
// the targets; and (host only) Chaos controls to inject lag, jitter,
// disconnects and drift into any member and watch the room heal.
import { FlaskConical, Unplug, X, Zap } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useMemo, useState } from 'react';
import type { Member } from '@shared/types';
import { Avatar, btn, useSession } from '../components/ui';
import { cx } from '../lib/util';
import { useRoom } from '../store';

const PROP_TARGET = 250;
const DRIFT_TARGET = 500;

export function SyncLab() {
  const open = useRoom((s) => s.ui.lab);
  const setUi = useRoom((s) => s.setUi);
  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          initial={{ x: 40, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 40, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 380, damping: 34 }}
          className="fixed top-16 right-3 bottom-3 z-40 flex w-[min(440px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-3xl border border-beam/25 bg-[#0d1218]/95 font-mono shadow-[0_30px_80px_-20px_#000] backdrop-blur-md"
          aria-label="Sync Lab"
        >
          <div className="flex items-center gap-2 border-b border-beam/15 px-4 py-3 text-beam">
            <FlaskConical size={16} />
            <span className="text-xs font-semibold tracking-[0.25em]">SYNC LAB</span>
            <span className="ml-2 text-[10px] text-beam/50">live · 1 Hz</span>
            <button className={cx(btn.icon, 'ml-auto size-8 text-beam/70')} onClick={() => setUi({ lab: false })} aria-label="Close Sync Lab">
              <X size={16} />
            </button>
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            <Kpis />
            <Members />
            <Waterfall />
            <p className="text-[10px] leading-relaxed text-beam/45">
              Propagation = click on one device → command applied on another, both measured on the server’s clock (each device’s clock offset is estimated
              NTP-style). Drift = |actual − expected| media position, sampled while playing after corrections settle. Raw data: <a className="underline" href="/metrics" target="_blank">/metrics</a>
            </p>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

function Kpis() {
  const latency = useRoom((s) => s.latency);
  const clock = useRoom((s) => s.clock);
  const seekLead = useRoom((s) => s.local.seekLead);
  return (
    <div className="grid grid-cols-2 gap-2">
      <Kpi label="Propagation p95" value={latency?.p95} unit="ms" target={PROP_TARGET} sub={latency?.count ? `p50 ${fmt(latency.p50)} · p99 ${fmt(latency.p99)} · n=${latency.count}` : 'play/pause/seek to collect'} />
      <Kpi label="Drift p95 (settled)" value={latency?.driftP95} unit="ms" target={DRIFT_TARGET} sub="after correction" />
      <Kpi label="Your clock offset" value={clock.synced ? clock.offset : null} unit="ms" sub={`± ${clock.jitter.toFixed(1)} ms jitter`} plain />
      <Kpi label="Your round trip" value={clock.rtt} unit="ms" sub={`learned seek lead ${Math.round(seekLead * 1000)} ms`} plain />
    </div>
  );
}

function fmt(v: number | null | undefined) {
  return v == null ? '—' : Math.abs(v) >= 100 ? Math.round(v).toString() : v.toFixed(1);
}

function Kpi({ label, value, unit, target, sub, plain }: { label: string; value: number | null | undefined; unit: string; target?: number; sub: string; plain?: boolean }) {
  const ok = value == null || target == null ? null : Math.abs(value) <= target;
  return (
    <div className="rounded-2xl border border-beam/15 bg-beam/[0.04] p-3">
      <div className="text-[9px] tracking-[0.18em] text-beam/55 uppercase">{label}</div>
      <div className={cx('mt-1 text-2xl font-semibold tabular-nums', plain || ok == null ? 'text-beam' : ok ? 'text-ok' : 'text-alarm')}>
        {fmt(value)}
        <span className="ml-1 text-xs font-normal text-beam/50">{unit}</span>
      </div>
      <div className="mt-0.5 truncate text-[10px] text-beam/45">
        {target != null && <span>target ≤ {target} · </span>}
        {sub}
      </div>
    </div>
  );
}

function Members() {
  const members = useRoom((s) => s.members);
  const telemetry = useRoom((s) => s.telemetry);
  const history = useRoom((s) => s.driftHistory);
  const me = useRoom((s) => (s.you ? s.members[s.you] : null));
  const chaosEnabled = useRoom((s) => s.chaosEnabled);
  const [open, setOpen] = useState<string | null>(null);
  const list = useMemo(() => Object.values(members).sort((a, b) => a.seat - b.seat), [members]);
  const canChaos = chaosEnabled && me?.role === 'host';
  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-[10px] tracking-[0.18em] text-beam/55 uppercase">
        <span>Members · drift (last 60 s)</span>
        {canChaos && <span className="text-bulb/80 normal-case tracking-normal">tap a row for chaos ⚡</span>}
      </div>
      <div className="space-y-1.5">
        {list.map((m) => {
          const t = telemetry[m.id];
          return (
            <div key={m.id} className="rounded-xl border border-beam/10 bg-black/20">
              <button className="flex w-full items-center gap-2.5 px-2.5 py-2 text-left" onClick={() => canChaos && setOpen(open === m.id ? null : m.id)}>
                <Avatar m={m} size={26} />
                <div className="w-20 min-w-0">
                  <div className="truncate font-sans text-xs text-paper">{m.name}</div>
                  <div className="truncate text-[9px] text-beam/50">{m.online ? m.player : 'offline'}</div>
                </div>
                <Sparkline data={history[m.id] ?? []} />
                <div className="w-[88px] text-right text-[10px] leading-tight tabular-nums">
                  <div className={cx(t?.drift == null ? 'text-beam/40' : Math.abs(t.drift) < 80 ? 'text-beam' : Math.abs(t.drift) < 500 ? 'text-bulb' : 'text-alarm')}>
                    {t?.drift == null ? '—' : `${t.drift > 0 ? '+' : ''}${Math.round(t.drift)} ms`}
                    {t?.rate != null && t.rate !== 1 && <span className="text-bulb"> {t.rate.toFixed(2)}×</span>}
                  </div>
                  <div className="text-beam/45">rtt {t?.rtt != null ? Math.round(t.rtt) : '—'} · off {t?.offset != null ? Math.round(t.offset) : '—'}</div>
                  {t?.chaos && (
                    <div className="text-bulb">
                      ⚡ {t.chaos.lagMs}±{t.chaos.jitterMs} ms
                    </div>
                  )}
                </div>
              </button>
              {open === m.id && canChaos && <ChaosControls m={m} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ChaosControls({ m }: { m: Member }) {
  const { client } = useSession();
  const t = useRoom((s) => s.telemetry[m.id]);
  const lag = t?.chaos?.lagMs ?? 0;
  const jitter = t?.chaos?.jitterMs ?? 0;
  const set = (lagMs: number, jitterMs: number) => client.send({ t: 'chaos', target: m.id, action: 'set', lagMs, jitterMs });
  return (
    <div className="space-y-2 border-t border-beam/10 px-3 py-2.5 text-[10px] text-beam/70">
      <Row label="Lag">
        {[0, 50, 150, 400, 1000].map((v) => (
          <Pill key={v} on={lag === v} onClick={() => set(v, jitter)}>
            {v}
          </Pill>
        ))}
      </Row>
      <Row label="Jitter">
        {[0, 20, 80, 200].map((v) => (
          <Pill key={v} on={jitter === v} onClick={() => set(lag, v)}>
            ±{v}
          </Pill>
        ))}
      </Row>
      <div className="flex flex-wrap gap-1.5 pt-1">
        <button className="inline-flex items-center gap-1 rounded-full border border-bulb/40 px-2.5 py-1 text-bulb hover:bg-bulb/10" onClick={() => client.send({ t: 'chaos', target: m.id, action: 'jump', seconds: 0.6 })}>
          <Zap size={11} /> Nudge 0.6 s (rate fix)
        </button>
        <button className="inline-flex items-center gap-1 rounded-full border border-bulb/40 px-2.5 py-1 text-bulb hover:bg-bulb/10" onClick={() => client.send({ t: 'chaos', target: m.id, action: 'jump', seconds: 4 })}>
          <Zap size={11} /> Knock 4 s (seek fix)
        </button>
        <button className="inline-flex items-center gap-1 rounded-full border border-alarm/40 px-2.5 py-1 text-alarm hover:bg-alarm/10" onClick={() => client.send({ t: 'chaos', target: m.id, action: 'drop' })}>
          <Unplug size={11} /> Drop connection
        </button>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-10 text-beam/45 uppercase">{label}</span>
      <div className="flex flex-wrap gap-1">{children}</div>
      <span className="text-beam/35">ms</span>
    </div>
  );
}

function Pill({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={cx('rounded-full px-2 py-0.5 tabular-nums', on ? 'bg-beam text-ink' : 'bg-beam/10 text-beam/80 hover:bg-beam/20')}>
      {children}
    </button>
  );
}

/** Drift sparkline: ±200 ms window, dead-zone band, target lines implied by color. */
function Sparkline({ data }: { data: number[] }) {
  const W = 120;
  const H = 30;
  const R = 200;
  const pts = data.map((v, i) => (Number.isFinite(v) ? `${(i / 59) * W},${H / 2 - (Math.max(-R, Math.min(R, v)) / R) * (H / 2)}` : null));
  const segs: string[][] = [[]];
  for (const p of pts) {
    if (p) segs[segs.length - 1].push(p);
    else if (segs[segs.length - 1].length) segs.push([]);
  }
  const last = [...data].reverse().find((v) => Number.isFinite(v));
  const color = last == null ? 'var(--color-beam)' : Math.abs(last) < 80 ? 'var(--color-beam)' : Math.abs(last) < 500 ? 'var(--color-bulb)' : 'var(--color-alarm)';
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="flex-1" aria-hidden>
      <rect x={0} y={H / 2 - (40 / R) * (H / 2)} width={W} height={(80 / R) * (H / 2)} fill="var(--color-beam)" opacity={0.07} />
      <line x1={0} x2={W} y1={H / 2} y2={H / 2} stroke="var(--color-beam)" strokeOpacity={0.2} strokeDasharray="2 3" />
      {segs
        .filter((s) => s.length > 1)
        .map((s, i) => (
          <polyline key={i} points={s.join(' ')} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
        ))}
    </svg>
  );
}

function Waterfall() {
  const latency = useRoom((s) => s.latency);
  const members = useRoom((s) => s.members);
  const recent = latency?.recent.slice(-10).reverse() ?? [];
  const max = Math.max(60, ...recent.map((r) => r.total));
  if (!recent.length) return null;
  return (
    <div>
      <div className="mb-2 text-[10px] tracking-[0.18em] text-beam/55 uppercase">Recent commands · network ▮ + player ▮</div>
      <div className="space-y-1">
        {recent.map((r, i) => (
          <div key={i} className="flex items-center gap-2 text-[10px]">
            <span className="w-11 shrink-0 text-beam/60">{r.kind}</span>
            <span className="w-14 shrink-0 truncate font-sans text-paper/70">→ {members[r.to]?.name ?? '…'}</span>
            <div className="flex h-2 flex-1 overflow-hidden rounded-full bg-beam/5">
              <div className="h-full bg-beam/70" style={{ width: `${(Math.max(0, r.delivery) / max) * 100}%` }} />
              <div className="h-full bg-bulb/80" style={{ width: `${(Math.max(0, r.apply) / max) * 100}%` }} />
            </div>
            <span className={cx('w-12 shrink-0 text-right tabular-nums', r.total <= PROP_TARGET ? 'text-ok' : 'text-alarm')}>{r.total.toFixed(1)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
