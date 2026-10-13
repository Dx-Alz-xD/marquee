// YouTube IFrame API adapter. Native controls are off and the iframe sits under
// an input shield, so every user intent goes through Marquee's own controls.
import { Emitter, type PlayerAdapter, type PlayerEvent } from './adapter';

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    YT?: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<any> | null = null;
function loadApi(): Promise<any> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  apiPromise ??= new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve(window.YT);
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => {
      apiPromise = null;
      reject(new Error('Could not reach YouTube'));
    };
    document.head.appendChild(s);
  });
  return apiPromise;
}

const YT_STATE = { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };

export class YouTubeAdapter implements PlayerAdapter {
  readonly kind = 'youtube';
  caps = { fineRate: false };
  private player: any = null;
  private ev = new Emitter();
  private state = -1;
  private rate = 1;
  private last = { t: 0, at: 0 };
  private mount: HTMLDivElement;
  private wrap: HTMLDivElement;

  constructor(
    private readonly host: HTMLElement,
    private readonly videoId: string,
  ) {
    const wrap = document.createElement('div');
    wrap.className = 'absolute inset-0 [&>iframe]:h-full [&>iframe]:w-full';
    this.mount = document.createElement('div');
    wrap.appendChild(this.mount);
    host.appendChild(wrap);
    this.wrap = wrap;
  }

  async load(): Promise<void> {
    const YT = await loadApi();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('YouTube player timed out')), 20_000);
      this.player = new YT.Player(this.mount, {
        videoId: this.videoId,
        width: '100%',
        height: '100%',
        playerVars: { controls: 0, disablekb: 1, modestbranding: 1, rel: 0, playsinline: 1, iv_load_policy: 3, fs: 0, origin: location.origin },
        events: {
          onReady: () => {
            clearTimeout(timer);
            const rates: number[] = this.player.getAvailablePlaybackRates?.() ?? [1];
            // Some clients expose fine-grained rates; use the smooth ladder when they do.
            this.caps.fineRate = rates.some((r) => r !== 1 && Math.abs(r - 1) < 0.1);
            resolve();
          },
          onStateChange: (e: { data: number }) => {
            this.state = e.data;
            if (e.data === YT_STATE.PLAYING) this.ev.emit('playing');
            if (e.data === YT_STATE.BUFFERING) this.ev.emit('waiting');
            if (e.data === YT_STATE.ENDED) this.ev.emit('ended');
            if (e.data === YT_STATE.PAUSED) this.ev.emit('pause');
            this.ev.emit('duration');
          },
          onError: (e: { data: number }) => {
            clearTimeout(timer);
            const msg =
              e.data === 101 || e.data === 150 ? 'The owner doesn’t allow this video to be embedded' : e.data === 100 ? 'Video not found or private' : 'YouTube could not play this video';
            this.ev.emit('error', msg);
            reject(new Error(msg));
          },
        },
      });
    });
  }

  /**
   * A cued YouTube player hasn't buffered anything, so the first play() after a
   * countdown can stall ~1–2 s. Warm it up: play muted until frames flow, then
   * park it paused at `at`. Only used while the room is paused/counting down.
   */
  async warmup(at: number): Promise<void> {
    const p = this.player;
    if (!p?.playVideo) return;
    p.mute();
    p.playVideo();
    const t0 = performance.now();
    while (this.state !== YT_STATE.PLAYING && performance.now() - t0 < 4000) await new Promise((r) => setTimeout(r, 50));
    p.pauseVideo();
    p.seekTo(at, true);
    this.last = { t: at, at: performance.now() };
  }

  play(): Promise<void> {
    this.player?.playVideo();
    return Promise.resolve();
  }
  pause() {
    this.player?.pauseVideo();
  }
  seek(t: number) {
    this.player?.seekTo(Math.max(0, t), true);
    this.last = { t: Math.max(0, t), at: performance.now() };
    setTimeout(() => this.ev.emit('seeked'), 0);
  }
  /** getCurrentTime() updates coarsely; interpolate between updates while playing. */
  getTime(): number {
    if (!this.player?.getCurrentTime) return 0;
    const raw: number = this.player.getCurrentTime() ?? 0;
    const now = performance.now();
    if (raw !== this.last.t) {
      this.last = { t: raw, at: now };
      return raw;
    }
    if (this.state === YT_STATE.PLAYING) return raw + ((now - this.last.at) / 1000) * this.rate;
    return raw;
  }
  get duration() {
    const d = this.player?.getDuration?.();
    return d && d > 0 ? d : null;
  }
  get paused() {
    return this.state !== YT_STATE.PLAYING && this.state !== YT_STATE.BUFFERING;
  }
  get buffering() {
    return this.state === YT_STATE.BUFFERING;
  }
  setRate(r: number) {
    if (r === this.rate) return;
    this.rate = r;
    this.player?.setPlaybackRate?.(r);
  }
  setVolume(v: number) {
    this.player?.setVolume?.(Math.round(v * 100));
  }
  setMuted(m: boolean) {
    if (m) this.player?.mute?.();
    else this.player?.unMute?.();
  }
  on(ev: PlayerEvent, cb: (d?: string) => void) {
    this.ev.on(ev, cb);
  }
  destroy() {
    this.ev.clear();
    try {
      this.player?.destroy();
    } catch {
      /* already gone */
    }
    this.wrap.remove();
  }
}
