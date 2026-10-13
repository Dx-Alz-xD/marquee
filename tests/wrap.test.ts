import { describe, expect, it } from 'vitest';
import type { MediaStats } from '../shared/types';
import { awards, topMoments, totals, verdict } from '../shared/wrap';

const base = (): MediaStats => ({
  mediaId: 'm',
  title: 'Film',
  thumbnail: null,
  movieId: null,
  startedAt: 0,
  endedAt: 1,
  watchedTo: 600,
  togetherSecs: 540,
  duration: 600,
  moments: {},
  reactions: {},
  chat: {},
  commands: {},
  drift: {},
  ratings: {},
  people: { a: { name: 'Ana', avatar: '🦊', color: '#f00' }, b: { name: 'Ben', avatar: '🐼', color: '#0f0' } },
});

describe('Movie Night Wrap', () => {
  it('merges adjacent bins into one moment and ranks by reactions', () => {
    const s = base();
    s.moments = { 2: { '🔥': 3 }, 3: { '🔥': 2, '😱': 1 }, 40: { '😂': 4 }, 90: { '😭': 1 } };
    const m = topMoments(s);
    expect(m[0]).toMatchObject({ time: 10, count: 6 });
    expect(m[0].emojis[0]).toEqual(['🔥', 5]);
    expect(m[1]).toMatchObject({ time: 200, count: 4 });
    expect(topMoments(s, { before: 100 })).toHaveLength(1); // catch-up only shows what happened before you joined
  });

  it('hands out awards to the right people', () => {
    const s = base();
    s.reactions = { a: { '😂': 5, '🔥': 1 }, b: { '😱': 4, '😭': 2 } };
    s.chat = { a: 1, b: 7 };
    s.drift = { a: { sum: 300, n: 10 }, b: { sum: 2000, n: 10 } };
    const byId = Object.fromEntries(awards(s).map((x) => [x.id, x.memberId]));
    expect(byId.comedian).toBe('a');
    expect(byId.drama).toBe('b');
    expect(byId.chatter).toBe('b');
    expect(byId.sniper).toBe('a');
    expect(byId.remote).toBeUndefined(); // nobody passed the threshold
  });

  it('computes the verdict and totals', () => {
    const s = base();
    s.ratings = { a: 5, b: 4 };
    s.reactions = { a: { '🔥': 2 } };
    s.chat = { b: 3 };
    expect(verdict(s)).toEqual({ avg: 4.5, count: 2 });
    expect(totals(s)).toEqual({ reactions: 2, messages: 3, people: 2 });
  });
});
