/**
 * Strict FIFO delay line. Used to simulate a slow link (Chaos mode, bots).
 * One timer drains items in insertion order — separate setTimeouts with equal
 * (or sub-millisecond-apart) deadlines can fire out of order, which would
 * reorder frames that TCP would never reorder.
 */
export class DelayQueue {
  private q: { at: number; fn: () => void }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  push(delayMs: number, fn: () => void) {
    const now = performance.now();
    if (delayMs <= 0 && !this.q.length) return fn();
    const last = this.q.length ? this.q[this.q.length - 1].at : 0;
    this.q.push({ at: Math.max(now + delayMs, last), fn });
    this.arm();
  }

  private arm() {
    if (this.timer || !this.q.length) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        const now = performance.now();
        while (this.q.length && this.q[0].at <= now + 0.5) this.q.shift()!.fn();
        this.arm();
      },
      Math.max(0, this.q[0].at - performance.now()),
    );
  }

  clear() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.q = [];
  }
}
