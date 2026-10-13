// Small helpers shared by client and server.

/** No 0/O, 1/I/L — codes get read aloud across a room. */
export const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;

export function randomRoomCode(rand: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) s += ROOM_ALPHABET[Math.floor(rand() * ROOM_ALPHABET.length)];
  return s;
}

/** Accepts "abc-def", "ABC DEF", a full invite URL… returns "ABCDEF" or null. */
export function normalizeRoomCode(input: string): string | null {
  const fromUrl = input.match(/\/r\/([A-Za-z0-9-]+)/);
  const raw = (fromUrl ? fromUrl[1] : input).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (raw.length !== ROOM_CODE_LENGTH) return null;
  for (const ch of raw) if (!ROOM_ALPHABET.includes(ch)) return null;
  return raw;
}

export function prettyCode(code: string): string {
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

export function uid(len = 12): string {
  const bytes = new Uint8Array(len);
  globalThis.crypto.getRandomValues(bytes);
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (const b of bytes) s += chars[b % chars.length];
  return s;
}

export function fmtTime(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return '--:--';
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** "1:02:03" | "12:34" → seconds. */
export function parseTimestamp(t: string): number | null {
  const parts = t.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

export const TIMESTAMP_RE = /\b(?:\d{1,2}:)?\d{1,2}:\d{2}\b/g;

export function parseYouTubeId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\.|^m\./, '');
    if (host === 'youtu.be') return valid(u.pathname.slice(1));
    if (host === 'youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com') {
      if (u.searchParams.get('v')) return valid(u.searchParams.get('v')!);
      const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/);
      if (m) return m[1];
    }
  } catch {
    /* not a URL */
  }
  return null;
  function valid(s: string) {
    return /^[A-Za-z0-9_-]{11}$/.test(s) ? s : null;
  }
}

export const AVATARS = ['🍿', '🎬', '🦊', '🐼', '🐙', '🦄', '👾', '🐸', '🌵', '🍕', '🚀', '🎧', '🐯', '🦉', '🍩', '⚡'];
export const COLORS = ['#ff6b6b', '#ffb347', '#ffd93d', '#6bcb77', '#4dd4c6', '#4d96ff', '#9b7bff', '#ff7ac8', '#f97316', '#22d3ee'];
export const REACTIONS = ['😂', '😱', '😍', '🔥', '👏', '😭', '🤯', '💀', '🍿', '👀'];

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}
