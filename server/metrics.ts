// Latency & drift measurement. Samples live in fixed-size rings; percentiles are
// computed on demand (n ≤ 20k — sorting is ~1 ms, far cheaper than an HDR dep).
import type { LatencySample, LatencySummary } from '../shared/types';
import { percentile } from '../shared/sync';

export class Ring<T> {
  private buf: T[] = [];
  constructor(private readonly cap: number) {}
  push(v: T): void {
    this.buf.push(v);
    if (this.buf.length > this.cap) this.buf.splice(0, this.buf.length - this.cap);
  }
  values(): T[] {
    return this.buf;
  }
  get size(): number {
    return this.buf.length;
  }
  clear(): void {
    this.buf = [];
  }
}

export interface Stats {
  count: number;
  mean: number | null;
  p50: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

export function stats(xs: number[]): Stats {
  if (!xs.length) return { count: 0, mean: null, p50: null, p90: null, p95: null, p99: null, max: null };
  const s = [...xs].sort((a, b) => a - b);
  const r = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10);
  return {
    count: s.length,
    mean: r(s.reduce((a, b) => a + b, 0) / s.length),
    p50: r(percentile(s, 50)),
    p90: r(percentile(s, 90)),
    p95: r(percentile(s, 95)),
    p99: r(percentile(s, 99)),
    max: r(s[s.length - 1]),
  };
}

/** Per-room + global sinks. */
export class Metrics {
  readonly latency = new Ring<LatencySample>(5000);
  readonly drift = new Ring<number>(4000); // |drift| ms, steady-state samples

  addLatency(s: LatencySample): void {
    this.latency.push(s);
    GLOBAL.latency.push(s);
  }

  addDrift(absMs: number): void {
    this.drift.push(absMs);
    GLOBAL.drift.push(absMs);
  }

  summary(): LatencySummary {
    const lat = this.latency.values();
    const total = stats(lat.map((x) => x.total));
    return {
      count: total.count,
      p50: total.p50,
      p95: total.p95,
      p99: total.p99,
      max: total.max,
      deliveryP95: stats(lat.map((x) => x.delivery)).p95,
      applyP95: stats(lat.map((x) => x.apply)).p95,
      driftP95: stats(this.drift.values()).p95,
      recent: lat.slice(-24),
    };
  }
}

export const GLOBAL = {
  latency: new Ring<LatencySample>(20000),
  drift: new Ring<number>(20000),
  startedAt: Date.now(),
};

export function globalReport() {
  const lat = GLOBAL.latency.values();
  const byKind: Record<string, Stats> = {};
  for (const kind of new Set(lat.map((x) => x.kind))) byKind[kind] = stats(lat.filter((x) => x.kind === kind).map((x) => x.total));
  return {
    uptimeSec: Math.round((Date.now() - GLOBAL.startedAt) / 1000),
    propagation: {
      definition: 'click on initiator → command applied to the player on each other member (server-clock ms)',
      total: stats(lat.map((x) => x.total)),
      delivery: stats(lat.map((x) => x.delivery)),
      apply: stats(lat.map((x) => x.apply)),
      byKind,
    },
    drift: {
      definition: '|actual − expected| media position per member, sampled every 2 s while playing (ms)',
      ...stats(GLOBAL.drift.values()),
    },
  };
}
