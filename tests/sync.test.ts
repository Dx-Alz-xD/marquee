import { describe, expect, it } from 'vitest';
import { DelayQueue } from '../shared/delay-queue';
import { ClockEstimator, SYNC, clockSample, decideCorrection, expectedPosition, isScheduled } from '../shared/sync';

const anchor = (o: Partial<{ status: 'playing' | 'paused'; position: number; at: number; rate: number }> = {}) => ({
  status: 'playing' as const,
  position: 10,
  at: 1_000_000,
  rate: 1,
  ...o,
});

describe('expectedPosition', () => {
  it('advances with server time while playing', () => {
    expect(expectedPosition(anchor(), 1_002_500)).toBeCloseTo(12.5);
  });
  it('is frozen while paused', () => {
    expect(expectedPosition(anchor({ status: 'paused' }), 1_100_000)).toBe(10);
  });
  it('holds the start position until a scheduled (countdown) start', () => {
    const p = anchor({ at: 2_000_000 });
    expect(isScheduled(p, 1_999_000)).toBe(true);
    expect(expectedPosition(p, 1_999_000)).toBe(10);
    expect(expectedPosition(p, 2_001_000)).toBeCloseTo(11);
  });
  it('clamps to the media duration and never goes negative', () => {
    expect(expectedPosition(anchor(), 9_000_000, 60)).toBe(60);
    expect(expectedPosition(anchor({ position: -3, status: 'paused' }), 0)).toBe(0);
  });
  it('respects playback rate', () => {
    expect(expectedPosition(anchor({ rate: 2 }), 1_001_000)).toBeCloseTo(12);
  });
});

describe('decideCorrection (the ladder)', () => {
  const base = { fineRate: true, correcting: false, expected: 100, seekLead: 0.1 };
  it('ignores drift inside the dead zone', () => {
    expect(decideCorrection({ ...base, drift: 0.03 }).kind).toBe('none');
  });
  it('slows down when ahead, speeds up when behind', () => {
    const ahead = decideCorrection({ ...base, drift: 0.3 });
    const behind = decideCorrection({ ...base, drift: -0.3 });
    expect(ahead.kind).toBe('rate');
    expect(behind.kind).toBe('rate');
    if (ahead.kind === 'rate' && behind.kind === 'rate') {
      expect(ahead.rate).toBeLessThan(1);
      expect(behind.rate).toBeGreaterThan(1);
      expect(Math.abs(1 - ahead.rate)).toBeLessThanOrEqual(SYNC.maxRateDelta + 1e-9);
    }
  });
  it('hard-seeks past the threshold, leading by the learned seek latency', () => {
    const c = decideCorrection({ ...base, drift: 2 });
    expect(c).toEqual({ kind: 'seek', target: 100.1 });
  });
  it('uses hysteresis: keeps correcting until well inside the dead zone', () => {
    expect(decideCorrection({ ...base, drift: 0.03, correcting: true }).kind).toBe('rate');
    expect(decideCorrection({ ...base, drift: 0.01, correcting: true }).kind).toBe('none');
  });
  it('coarse players (YouTube) seek at a lower threshold and never rate-correct', () => {
    expect(decideCorrection({ ...base, fineRate: false, drift: 0.3 }).kind).toBe('none');
    expect(decideCorrection({ ...base, fineRate: false, drift: 0.4 }).kind).toBe('seek');
  });
});

describe('closed-loop convergence (virtual time)', () => {
  /** A skewed player driven by the ladder, simulated at the real tick rate. */
  function simulate(initialDrift: number, skew: number, fineRate: boolean, seconds: number) {
    let pos = 50 + initialDrift;
    let rate = 1;
    let correcting = false;
    let cooldownUntil = 0;
    const dt = SYNC.tickMs / 1000;
    const trace: number[] = [];
    for (let t = 0; t < seconds; t += dt) {
      const expected = 50 + t;
      const drift = pos - expected;
      trace.push(drift);
      if (t >= cooldownUntil) {
        const c = decideCorrection({ drift, fineRate, correcting, expected, seekLead: 0.08 });
        if (c.kind === 'seek') {
          pos = c.target - 0.08; // the seek itself costs ~seekLead
          rate = 1;
          correcting = false;
          cooldownUntil = t + SYNC.seekCooldownMs / 1000;
          continue;
        }
        rate = c.kind === 'rate' ? c.rate : 1;
        correcting = c.kind === 'rate';
      }
      pos += dt * rate * skew;
    }
    return trace;
  }

  it.each([0.6, -0.6, 0.2, -0.95])('glides %ss of drift back under the dead zone without seeking', (d) => {
    const trace = simulate(d, 1.002, true, 20);
    expect(Math.abs(trace.at(-1)!)).toBeLessThan(SYNC.deadZone);
    expect(Math.max(...trace.slice(-25).map(Math.abs))).toBeLessThan(0.05);
  });

  it('recovers from multi-second drift with a seek, then stays within 50 ms', () => {
    const trace = simulate(4, 0.997, true, 15);
    expect(Math.max(...trace.slice(-30).map(Math.abs))).toBeLessThan(0.05);
  });

  it('keeps a coarse (YouTube-style) player within the 500 ms target', () => {
    const trace = simulate(3, 1.004, false, 60);
    expect(Math.max(...trace.slice(-100).map(Math.abs))).toBeLessThan(0.5);
  });
});

describe('clock sync', () => {
  it('recovers a known offset from a symmetric exchange', () => {
    // client clock is 5000 ms behind the server; one-way delay 20 ms each way
    const c0 = 1000;
    const s1 = c0 + 5000 + 20;
    const s2 = s1 + 1;
    const c3 = c0 + 41;
    const s = clockSample(c0, s1, s2, c3);
    expect(s.offset).toBeCloseTo(5000);
    expect(s.rtt).toBeCloseTo(40);
  });

  it('stays within 15 ms of the truth under jittery, asymmetric queuing with spikes', () => {
    const TRUE = 1234.5;
    const est = new ClockEstimator();
    let c = 0;
    for (let i = 0; i < 40; i++) {
      const up = 5 + Math.random() * 30 + (Math.random() < 0.15 ? 200 : 0); // occasional spike one way
      const down = 5 + Math.random() * 30;
      const c0 = (c += 1000);
      const s1 = c0 + TRUE + up;
      const s2 = s1 + 0.2;
      const c3 = s2 - TRUE + down;
      est.add(clockSample(c0, s1, s2, c3));
    }
    expect(Math.abs(est.offset - TRUE)).toBeLessThan(15);
    expect(est.synced).toBe(true);
  });
});

describe('DelayQueue', () => {
  it('delivers in FIFO order even when deadlines collide', async () => {
    const q = new DelayQueue();
    const out: number[] = [];
    for (let i = 0; i < 200; i++) q.push(i % 7 === 0 ? 30 : Math.random() * 30, () => out.push(i));
    await new Promise((r) => setTimeout(r, 120));
    expect(out).toEqual(Array.from({ length: 200 }, (_, i) => i));
  });
});
