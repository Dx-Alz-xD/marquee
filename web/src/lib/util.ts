import { AVATARS, COLORS } from '@shared/util';
import type { Movie, MovieHit, Shelf } from '@shared/types';

// ─── Tiny router (history API) ───────────────────────────────────────────────
export function navigate(path: string) {
  history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

// ─── Identity (per browser) ──────────────────────────────────────────────────
export interface Identity {
  name: string;
  avatar: string;
  color: string;
}

const safe = {
  get(store: Storage, k: string): string | null {
    try {
      return store.getItem(k);
    } catch {
      return null;
    }
  },
  set(store: Storage, k: string, v: string) {
    try {
      store.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

/** Per-tab first (two tabs = two people when demoing), falling back to this browser's last identity. */
export function loadIdentity(): Identity {
  try {
    const raw = safe.get(sessionStorage, 'marquee:identity') ?? safe.get(localStorage, 'marquee:identity');
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return { name: '', avatar: AVATARS[Math.floor(Math.random() * AVATARS.length)], color: COLORS[Math.floor(Math.random() * COLORS.length)] };
}

export function saveIdentity(i: Identity) {
  safe.set(sessionStorage, 'marquee:identity', JSON.stringify(i));
  safe.set(localStorage, 'marquee:identity', JSON.stringify(i));
}

/** Resume token lives in sessionStorage: survives refresh, but every tab is its own seat. */
export const tokenStore = {
  get: (code: string) => safe.get(sessionStorage, `marquee:token:${code}`),
  set: (code: string, token: string) => safe.set(sessionStorage, `marquee:token:${code}`, token),
};

export function isMobile(): boolean {
  return matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820;
}

// ─── API ─────────────────────────────────────────────────────────────────────
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? `HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

export interface ServerInfo {
  lanUrls: string[];
  port: number;
  publicUrl: string | null;
  tunnel: string;
  tmdb: { configured: boolean; seeding: boolean; seeded: boolean; error: string | null };
  catalog: { total: number };
  chaos: boolean;
}

export interface SearchResponse {
  results: MovieHit[];
  total: number;
  parsed: { text: string; chips: { key: string; label: string }[] };
  tookMs: number;
}

export interface CatalogMeta {
  genres: string[];
  moods: { id: string; title: string; subtitle: string }[];
  languages: { code: string; count: number }[];
  yearMin: number;
  yearMax: number;
  total: number;
  playable: number;
}

export type { Movie, MovieHit, Shelf };

// ─── Clipboard (works on plain-http LAN origins too) ─────────────────────────
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  return ok;
}

// ─── Local-file fingerprint ──────────────────────────────────────────────────
// crypto.subtle is unavailable on http:// LAN origins, so we use a portable
// 2×32-bit FNV-1a over size + first/last MiB. Same algorithm everywhere ⇒ same
// fingerprint for the same file on every device.
export async function fingerprintFile(file: File): Promise<string> {
  const CHUNK = 1024 * 1024;
  const head = new Uint8Array(await file.slice(0, CHUNK).arrayBuffer());
  const tail = new Uint8Array(await file.slice(Math.max(0, file.size - CHUNK)).arrayBuffer());
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ (file.size >>> 0);
  const feed = (bytes: Uint8Array) => {
    for (let i = 0; i < bytes.length; i++) {
      h1 = Math.imul(h1 ^ bytes[i], 16777619);
      h2 = Math.imul(h2 ^ bytes[i] ^ (i & 0xff), 2246822507);
    }
  };
  feed(head);
  feed(tail);
  const hex = (n: number, w: number) => (n >>> 0).toString(16).padStart(w, '0');
  return hex(Math.floor(file.size / 2 ** 32), 4) + hex(file.size, 8) + hex(h1, 8) + hex(h2, 8);
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) (v /= 1024), i++;
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** Deterministic gradient for posterless titles. */
export function titleHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function cx(...xs: (string | false | null | undefined)[]): string {
  return xs.filter(Boolean).join(' ');
}

export function minutesToMidnight(): number {
  const d = new Date();
  return 24 * 60 - (d.getHours() * 60 + d.getMinutes());
}
