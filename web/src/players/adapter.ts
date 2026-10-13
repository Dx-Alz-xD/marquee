// One interface over very different players. The sync engine only talks to this.
export type PlayerEvent = 'seeked' | 'waiting' | 'playing' | 'ended' | 'error' | 'duration' | 'pause';

export interface PlayerAdapter {
  readonly kind: 'html5' | 'youtube';
  /** Arbitrary playbackRate (HTML5) vs. a fixed menu (YouTube) — picks the correction ladder. */
  caps: { fineRate: boolean };
  load(): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  seek(t: number): void;
  getTime(): number;
  readonly duration: number | null;
  readonly paused: boolean;
  readonly buffering: boolean;
  setRate(r: number): void;
  setVolume(v: number): void;
  setMuted(m: boolean): void;
  on(ev: PlayerEvent, cb: (detail?: string) => void): void;
  destroy(): void;
}

export class Emitter {
  private handlers = new Map<PlayerEvent, ((d?: string) => void)[]>();
  on(ev: PlayerEvent, cb: (d?: string) => void) {
    this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), cb]);
  }
  emit(ev: PlayerEvent, d?: string) {
    for (const cb of this.handlers.get(ev) ?? []) cb(d);
  }
  clear() {
    this.handlers.clear();
  }
}
