// Server clock: monotonic (immune to NTP steps) but epoch-based, so anchors stay
// meaningful across restarts and persisted rooms resume seamlessly.
export const serverNow = (): number => performance.timeOrigin + performance.now();

/** Token bucket rate limiter. */
export class Bucket {
  private tokens: number;
  private last = performance.now();
  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
  ) {
    this.tokens = burst;
  }
  take(n = 1): boolean {
    const t = performance.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.ratePerSec);
    this.last = t;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}
