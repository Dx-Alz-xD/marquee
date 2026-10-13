// ─────────────────────────────────────────────────────────────────────────────
// Sync core — pure functions shared by the browser engine, the server and the
// benchmark bots. No DOM, no timers: everything here is deterministic and unit
// tested (tests/sync.test.ts).
// ─────────────────────────────────────────────────────────────────────────────
import type { PlaybackState } from './types';

/** Tunables for the drift-correction ladder. Seconds unless noted. */
export const SYNC = {
  /** Below this |drift| we do nothing (avoids fighting decoder jitter). */
  deadZone: 0.04,
  /** Once a rate correction is running, keep going until |drift| is under this (hysteresis). */
  rateExit: 0.015,
  /** Above this |drift| a fine-rate player hard-seeks instead of nudging. */
  seekThreshold: 1.0,
  /** Players without fine playbackRate control (YouTube) seek above this. */
  coarseSeekThreshold: 0.35,
  /** Max playbackRate deviation from 1.0 (pitch-preserved, practically inaudible). */
  maxRateDelta: 0.08,
  /** Proportional gain: aim to close the gap over this many seconds. */
  rateHorizon: 2.0,
  /** After a seek, ignore drift for this long (ms) — the player is settling. */
  seekCooldownMs: 900,
  /** Paused: re-seek if the frame is further than this from the anchor. */
  pausedTolerance: 0.12,
  /** Correction loop period (ms). */
  tickMs: 200,
} as const;

type Anchor = Pick<PlaybackState, 'status' | 'position' | 'at' | 'rate'>;

/** Where the media *should* be at `serverNow` (server-clock ms). */
export function expectedPosition(p: Anchor, serverNow: number, duration?: number | null): number {
  let pos = p.position;
  if (p.status === 'playing') {
    const elapsed = (serverNow - p.at) / 1000;
    if (elapsed > 0) pos += elapsed * p.rate;
  }
  if (duration && duration > 0) pos = Math.min(pos, duration);
  return Math.max(0, pos);
}

/** Playing, but the anchor is in the future → a countdown is running. */
export function isScheduled(p: Anchor, serverNow: number): boolean {
  return p.status === 'playing' && p.at > serverNow;
}

export type Correction =
  | { kind: 'none'; rate: 1 }
  | { kind: 'rate'; rate: number }
  | { kind: 'seek'; target: number };

export interface CorrectionInput {
  /** actual − expected, seconds. Positive ⇒ we are ahead. */
  drift: number;
  /** Player supports arbitrary playbackRate (HTML5) vs. a fixed set (YouTube). */
  fineRate: boolean;
  /** A rate correction is currently in progress (for hysteresis). */
  correcting: boolean;
  /** Where we should be right now. */
  expected: number;
  /** Learned time this device needs to complete a seek (s); we seek that far ahead. */
  seekLead: number;
}

/**
 * The correction ladder:
 *   |d| < deadZone            → nothing
 *   deadZone ≤ |d| < seek     → proportional playbackRate nudge (fine-rate players)
 *   |d| ≥ seek threshold      → hard seek to expected + learned seek latency
 */
export function decideCorrection(i: CorrectionInput): Correction {
  const a = Math.abs(i.drift);
  const seekAt = i.fineRate ? SYNC.seekThreshold : SYNC.coarseSeekThreshold;
  if (a >= seekAt) return { kind: 'seek', target: Math.max(0, i.expected + i.seekLead) };
  if (!i.fineRate) return { kind: 'none', rate: 1 };
  const threshold = i.correcting ? SYNC.rateExit : SYNC.deadZone;
  if (a < threshold) return { kind: 'none', rate: 1 };
  const delta = clamp(i.drift / SYNC.rateHorizon, -SYNC.maxRateDelta, SYNC.maxRateDelta);
  // Ahead (drift > 0) ⇒ slow down; behind ⇒ speed up. Round to 3 dp to avoid churn.
  return { kind: 'rate', rate: Math.round((1 - delta) * 1000) / 1000 };
}

// ─── Clock synchronisation (NTP-style) ───────────────────────────────────────

export interface ClockSample {
  /** server − client, ms */
  offset: number;
  rtt: number;
  at: number;
}

/**
 * c0: client send, s1: server receive, s2: server send, c3: client receive.
 * offset = ((s1 − c0) + (s2 − c3)) / 2 ; rtt = (c3 − c0) − (s2 − s1)
 */
export function clockSample(c0: number, s1: number, s2: number, c3: number): ClockSample {
  return { offset: (s1 - c0 + (s2 - c3)) / 2, rtt: Math.max(0, c3 - c0 - (s2 - s1)), at: c3 };
}

/**
 * Keeps a window of samples and estimates the offset from the lowest-RTT third
 * (those suffered the least queuing delay, so their midpoint assumption is best).
 */
export class ClockEstimator {
  private samples: ClockSample[] = [];
  offset = 0;
  rtt = 0;
  jitter = 0;
  synced = false;
  constructor(private readonly window = 24) {}

  add(s: ClockSample): void {
    this.samples.push(s);
    if (this.samples.length > this.window) this.samples.shift();
    const byRtt = [...this.samples].sort((a, b) => a.rtt - b.rtt);
    const best = byRtt.slice(0, Math.max(1, Math.ceil(byRtt.length / 3)));
    const next = median(best.map((x) => x.offset));
    // Smooth small corrections, jump on large ones (laptop sleep, clock step).
    this.offset = !this.synced || Math.abs(next - this.offset) > 25 ? next : this.offset + (next - this.offset) * 0.35;
    const rtts = this.samples.map((x) => x.rtt);
    this.rtt = median(rtts.slice(-8));
    this.jitter = stddev(rtts.slice(-8));
    this.synced = this.samples.length >= 3;
  }

  reset(): void {
    this.samples = [];
    this.synced = false;
  }

  get sampleCount(): number {
    return this.samples.length;
  }
}

// ─── Small helpers ───────────────────────────────────────────────────────────

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
}

export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}
