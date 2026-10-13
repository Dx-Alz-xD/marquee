// <video> adapter for MP4/WebM files, HLS (hls.js or native) and local files.
import type Hls from 'hls.js';
import { Emitter, type PlayerAdapter, type PlayerEvent } from './adapter';

export class Html5Adapter implements PlayerAdapter {
  readonly kind = 'html5';
  caps = { fineRate: true };
  readonly video: HTMLVideoElement;
  private hls: Hls | null = null;
  private ev = new Emitter();

  constructor(
    private readonly host: HTMLElement,
    private readonly src: { url: string; hls: boolean },
  ) {
    const v = document.createElement('video');
    v.playsInline = true;
    v.preload = 'auto';
    v.controls = false;
    v.disableRemotePlayback = true;
    v.className = 'absolute inset-0 h-full w-full bg-black object-contain';
    // Keep the pitch natural while the drift controller nudges playbackRate.
    v.preservesPitch = true;
    host.appendChild(v);
    this.video = v;
    for (const name of ['seeked', 'waiting', 'playing', 'ended', 'pause'] as const) v.addEventListener(name, () => this.ev.emit(name));
    v.addEventListener('durationchange', () => this.ev.emit('duration'));
    v.addEventListener('error', () => this.ev.emit('error', v.error?.message || 'This video could not be played'));
  }

  async load(): Promise<void> {
    const v = this.video;
    if (this.src.hls && !v.canPlayType('application/vnd.apple.mpegurl')) {
      const { default: HlsCtor } = await import('hls.js');
      if (!HlsCtor.isSupported()) throw new Error('HLS is not supported in this browser');
      const hls = new HlsCtor({ maxBufferLength: 30, backBufferLength: 30 });
      this.hls = hls;
      hls.on(HlsCtor.Events.ERROR, (_e, data) => {
        if (data.fatal) this.ev.emit('error', `Stream error: ${data.details}`);
      });
      hls.loadSource(this.src.url);
      hls.attachMedia(v);
    } else {
      v.src = this.src.url;
    }
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        cleanup();
        resolve();
      };
      const fail = () => {
        cleanup();
        reject(new Error(v.error?.message || 'This video could not be loaded'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out loading video'));
      }, 30_000);
      const cleanup = () => {
        clearTimeout(timer);
        v.removeEventListener('loadedmetadata', done);
        v.removeEventListener('error', fail);
      };
      if (v.readyState >= 1) return done();
      v.addEventListener('loadedmetadata', done);
      v.addEventListener('error', fail);
    });
  }

  play(): Promise<void> {
    return this.video.play();
  }
  pause() {
    if (!this.video.paused) this.video.pause();
  }
  seek(t: number) {
    const d = this.duration;
    this.video.currentTime = Math.max(0, d ? Math.min(t, d - 0.05) : t);
  }
  getTime() {
    return this.video.currentTime;
  }
  get duration() {
    const d = this.video.duration;
    return Number.isFinite(d) && d > 0 ? d : null;
  }
  get paused() {
    return this.video.paused;
  }
  get buffering() {
    const v = this.video;
    return !v.ended && !!v.currentSrc && (v.seeking || v.readyState < HTMLMediaElement.HAVE_FUTURE_DATA);
  }
  setRate(r: number) {
    if (Math.abs(this.video.playbackRate - r) > 0.0005) this.video.playbackRate = r;
  }
  setVolume(v: number) {
    this.video.volume = v;
  }
  setMuted(m: boolean) {
    this.video.muted = m;
  }
  on(ev: PlayerEvent, cb: (d?: string) => void) {
    this.ev.on(ev, cb);
  }
  destroy() {
    this.ev.clear();
    this.hls?.destroy();
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this.video.remove();
  }
}
