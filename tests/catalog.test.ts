import { describe, expect, it } from 'vitest';
import type { Movie } from '../shared/types';
import { Catalog } from '../server/catalog/catalog';
import { decade, fold, parseQuery, parseRange } from '../server/catalog/query';
import { featureVec, groupRecommend, type RecContext } from '../server/catalog/recommend';

describe('query language', () => {
  it('parses operators, ranges, decades and aliases', () => {
    const q = parseQuery('nolan sci-fi year:>2010 runtime:<150 rating:7+ by:villeneuve with:"amy adams" is:free');
    expect(q.text).toBe('nolan');
    expect(q.filters.genres).toEqual(['Science Fiction']);
    expect(q.filters.year).toEqual({ min: 2011 });
    expect(q.filters.runtime).toEqual({ max: 150 });
    expect(q.filters.rating).toEqual({ min: 7 });
    expect(q.filters.director).toBe('villeneuve');
    expect(q.filters.cast).toBe('amy adams');
    expect(q.filters.playable).toBe(true);
    expect(q.chips.length).toBe(7);
  });
  it('understands bare decades and ranges', () => {
    expect(decade('90s')).toEqual({ min: 1990, max: 1999 });
    expect(decade('1960s')).toEqual({ min: 1960, max: 1969 });
    expect(parseRange('2000-2005', 'year')).toEqual({ min: 2000, max: 2005 });
    expect(parseQuery('90s horror').filters.year).toEqual({ min: 1990, max: 1999 });
  });
  it('folds diacritics and apostrophes', () => {
    expect(fold('Amélie')).toBe('amelie');
    expect(fold("Schindler's")).toBe('schindlers');
  });
});

describe('fuzzy search (bundled free catalog)', () => {
  const cat = new Catalog();
  it('forgives typos', () => {
    expect(cat.search({ q: 'nosferato' }).results[0]?.title).toBe('Nosferatu');
    expect(cat.search({ q: 'metropolys' }).results[0]?.title).toBe('Metropolis');
  });
  it('matches people and explains why', () => {
    const r = cat.search({ q: 'keaton year:<1930' });
    expect(r.results.map((m) => m.title).sort()).toEqual(['Sherlock Jr.', 'The General']);
    expect(r.results[0].reason).toMatch(/Buster Keaton/);
  });
  it('filters without text, fast', () => {
    const r = cat.search({ genres: ['Horror'], playable: true });
    expect(r.results.length).toBeGreaterThan(3);
    expect(r.results.every((m) => m.genres.includes('Horror'))).toBe(true);
    expect(r.tookMs).toBeLessThan(50);
  });
  it('builds discovery shelves', () => {
    const shelves = cat.shelves({});
    expect(shelves.find((s) => s.id === 'free')?.movies.length).toBeGreaterThan(10);
  });
});

describe('group recommender (average without misery)', () => {
  const mk = (id: string, genres: string[], director: string | null = null): Movie => ({
    id,
    title: id,
    year: 2010,
    overview: '',
    genres,
    runtime: 100,
    rating: 7,
    votes: 100,
    popularity: 1,
    language: 'en',
    director,
    cast: [],
    keywords: [],
    poster: null,
    backdrop: null,
    trailer: 'x',
    playable: null,
    source: 'tmdb',
  });
  const movies = [
    mk('horror1', ['Horror']),
    mk('horror2', ['Horror']),
    mk('horror3', ['Horror', 'Thriller']),
    mk('comedy1', ['Comedy'], 'Wright'),
    mk('comedy2', ['Comedy'], 'Wright'),
    mk('comedy3', ['Comedy', 'Romance']),
    mk('scifi1', ['Science Fiction', 'Comedy'], 'Wright'),
  ];
  const vecs = new Map(movies.map((m) => [m.id, featureVec(m)]));
  const ctx: RecContext = { movies, get: (id) => movies.find((m) => m.id === id), vec: (id) => vecs.get(id) ?? new Map() };

  it('never recommends what a member clearly dislikes, and says why', () => {
    const recs = groupRecommend(ctx, [
      { memberId: '1', name: 'Ana', likes: ['comedy1'], dislikes: ['horror1'] },
      { memberId: '2', name: 'Ben', likes: ['horror2', 'comedy2'], dislikes: [] },
    ]);
    const ids = recs.map((r) => r.movie.id);
    expect(ids).not.toContain('horror3');
    expect(ids[0]).toMatch(/comedy|scifi/);
    expect(recs[0].reason).toMatch(/liked/);
  });
});
