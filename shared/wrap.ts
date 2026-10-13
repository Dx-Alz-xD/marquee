// Turns a film's raw MediaStats into the Movie Night Wrap: top moments, awards
// and the room verdict. Pure functions, shared by the UI and the tests.
import { HEAT_BIN_SECONDS, type MediaStats } from './types';

export interface Moment {
  time: number; // seconds
  count: number;
  emojis: [string, number][];
}

/** Busiest reaction moments; adjacent 5 s bins are merged so one scene counts once. */
export function topMoments(s: MediaStats, opts: { before?: number; limit?: number } = {}): Moment[] {
  const bins = Object.entries(s.moments)
    .map(([i, emojis]) => ({ i: Number(i), emojis }))
    .filter((b) => opts.before == null || b.i * HEAT_BIN_SECONDS < opts.before)
    .sort((a, b) => a.i - b.i);
  const groups: { start: number; end: number; emojis: Record<string, number> }[] = [];
  for (const b of bins) {
    const g = groups.at(-1);
    if (g && b.i - g.end <= 1) {
      g.end = b.i;
      for (const [e, n] of Object.entries(b.emojis)) g.emojis[e] = (g.emojis[e] ?? 0) + n;
    } else groups.push({ start: b.i, end: b.i, emojis: { ...b.emojis } });
  }
  return groups
    .map((g) => {
      const emojis = Object.entries(g.emojis).sort((a, b) => b[1] - a[1]);
      return { time: g.start * HEAT_BIN_SECONDS, count: emojis.reduce((a, [, n]) => a + n, 0), emojis: emojis.slice(0, 3) as [string, number][] };
    })
    .sort((a, b) => b.count - a.count || a.time - b.time)
    .slice(0, opts.limit ?? 3);
}

export interface Award {
  id: string;
  icon: string;
  title: string;
  memberId: string;
  detail: string;
}

const sumOf = (r: Record<string, number> | undefined, emojis?: string[]) =>
  Object.entries(r ?? {}).reduce((a, [e, n]) => a + (!emojis || emojis.includes(e) ? n : 0), 0);

export function awards(s: MediaStats): Award[] {
  const people = Object.keys(s.people);
  const best = (score: (id: string) => number, min = 1) => {
    let top: string | null = null;
    let v = -Infinity;
    for (const id of people) {
      const x = score(id);
      if (x >= min && x > v) (top = id), (v = x);
    }
    return top ? { id: top, v } : null;
  };
  const out: Award[] = [];
  const push = (id: string, icon: string, title: string, r: { id: string; v: number } | null, detail: (v: number) => string) => {
    if (r) out.push({ id, icon, title, memberId: r.id, detail: detail(r.v) });
  };
  push('hype', '🔥', 'Hype machine', best((id) => sumOf(s.reactions[id]), 3), (v) => `${v} reactions`);
  push('drama', '😱', 'Most dramatic', best((id) => sumOf(s.reactions[id], ['😱', '😭', '🤯', '😍'])), (v) => `${v} gasps & sobs`);
  push('comedian', '😂', 'Laughed the loudest', best((id) => sumOf(s.reactions[id], ['😂', '💀'])), (v) => `${v} laughs`);
  push('chatter', '💬', 'Chatterbox', best((id) => s.chat[id] ?? 0, 3), (v) => `${v} messages`);
  push('remote', '🎛', 'Remote hog', best((id) => s.commands[id] ?? 0, 3), (v) => `${v} play/pause/seeks`);
  const sniper = best(
    (id) => {
      const d = s.drift[id];
      return d && d.n >= 3 ? 1000 - d.sum / d.n : -1;
    },
    0,
  );
  if (sniper) out.push({ id: 'sniper', icon: '🎯', title: 'Sync sniper', memberId: sniper.id, detail: `${Math.round(1000 - sniper.v)} ms average drift` });
  return out;
}

export function verdict(s: MediaStats): { avg: number; count: number } | null {
  const r = Object.values(s.ratings);
  if (!r.length) return null;
  return { avg: r.reduce((a, b) => a + b, 0) / r.length, count: r.length };
}

export function totals(s: MediaStats) {
  return {
    reactions: Object.values(s.reactions).reduce((a, r) => a + sumOf(r), 0),
    messages: Object.values(s.chat).reduce((a, b) => a + b, 0),
    people: Object.keys(s.people).length,
  };
}
