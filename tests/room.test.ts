import { describe, expect, it } from 'vitest';
import type { HelloMsg, RoomEvent, ServerMsg } from '../shared/protocol';
import type { Movie } from '../shared/types';
import type { Catalog } from '../server/catalog/catalog';
import { serverNow } from '../server/clock';
import { Room, type Conn, type MemberRec } from '../server/room';

class FakeConn implements Conn {
  chaos = null;
  msgs: ServerMsg[] = [];
  closed: number | null = null;
  send(data: string) {
    this.msgs.push(JSON.parse(data));
  }
  close(code: number) {
    this.closed = code;
  }
  events(): RoomEvent[] {
    return this.msgs.flatMap((m) => (m.t === 'ev' ? [m.ev] : []));
  }
  last<T extends ServerMsg['t']>(t: T) {
    return [...this.msgs].reverse().find((m) => m.t === t) as Extract<ServerMsg, { t: T }> | undefined;
  }
}

const movie = (id: string, genres: string[], extra: Partial<Movie> = {}): Movie => ({
  id,
  title: id.toUpperCase(),
  year: 2000,
  overview: '',
  genres,
  runtime: 100,
  rating: 7,
  votes: 1000,
  popularity: 10,
  language: 'en',
  director: null,
  cast: [],
  keywords: [],
  poster: null,
  backdrop: null,
  trailer: 'dQw4w9WgXcQ',
  playable: null,
  source: 'tmdb',
  ...extra,
});

const MOVIES = [movie('a', ['Horror']), movie('b', ['Comedy']), movie('c', ['Drama'])];
const fakeCatalog = {
  get: (id: string) => MOVIES.find((m) => m.id === id),
  recommend: () => MOVIES.map((m) => ({ movie: m, score: 1, reason: null })),
} as unknown as Catalog;

function setup(controlMode: 'host' | 'everyone' | 'democracy' = 'everyone') {
  const room = new Room('ABCDEF', { name: 't', controlMode, syncPolicy: 'strict', autoplayNext: true, passcode: null }, { catalog: fakeCatalog, chaosEnabled: true, cap: 50 });
  const join = (name: string, extra: Partial<HelloMsg> = {}) => {
    const conn = new FakeConn();
    const r = room.join({ t: 'hello', v: 1, room: 'ABCDEF', name, avatar: '🙂', color: '#ffffff', device: 'desktop', ...extra }, conn);
    if (!r.ok) throw new Error(r.message);
    return { m: r.member as MemberRec, conn };
  };
  return { room, join };
}

function load(room: Room, by: MemberRec) {
  room.handle(by, { t: 'pl', op: 'add', media: { kind: 'file', title: 'Film', url: 'https://example.com/f.mp4', duration: 600 } });
}

describe('membership', () => {
  it('first person hosts, others get the next free seat', () => {
    const { join } = setup();
    const a = join('Ana');
    const b = join('Ben');
    expect(a.m.role).toBe('host');
    expect(b.m.role).toBe('member');
    expect([a.m.seat, b.m.seat]).toEqual([0, 1]);
    expect(a.conn.last('welcome')?.snapshot.members).toHaveLength(1);
    expect(b.conn.last('welcome')?.snapshot.members).toHaveLength(2);
  });

  it('resumes the same seat & role, replaying exactly the missed events', () => {
    const { room, join } = setup();
    const a = join('Ana');
    const welcome = a.conn.last('welcome')!;
    room.detach(a.m, a.conn, false);
    const b = join('Ben');
    b.conn.msgs = [];
    room.handle(b.m, { t: 'chat', id: 'm1', text: 'you missed this', mediaTime: null });
    const conn2 = new FakeConn();
    const r = room.join({ t: 'hello', v: 1, room: 'ABCDEF', name: 'Ana', avatar: '🙂', color: '#ffffff', device: 'desktop', token: welcome.token, lastSeq: welcome.seq }, conn2);
    expect(r.ok && r.member.id).toBe(a.m.id);
    expect(a.m.role).toBe('host');
    expect(conn2.msgs[0].t).toBe('resumed');
    const replayedChat = conn2.events().filter((e) => e.e === 'chat' && e.message.text === 'you missed this');
    expect(replayedChat).toHaveLength(1);
  });

  it('hands host to the longest-present member when the host leaves', () => {
    const { room, join } = setup();
    const a = join('Ana');
    const b = join('Ben');
    const c = join('Cy');
    room.handle(a.m, { t: 'leave' });
    expect(b.m.role).toBe('host');
    expect(c.m.role).toBe('member');
  });

  it('prefers a co-host as successor', () => {
    const { room, join } = setup();
    const a = join('Ana');
    join('Ben');
    const c = join('Cy');
    room.handle(a.m, { t: 'role', op: 'cohost', target: c.m.id });
    room.handle(a.m, { t: 'leave' });
    expect(c.m.role).toBe('host');
  });

  it('kicked members cannot rejoin with their token', () => {
    const { room, join } = setup();
    const a = join('Ana');
    const b = join('Ben');
    const token = b.conn.last('welcome')!.token;
    room.handle(a.m, { t: 'role', op: 'kick', target: b.m.id });
    const r = room.join({ t: 'hello', v: 1, room: 'ABCDEF', name: 'Ben', avatar: '🙂', color: '#ffffff', device: 'desktop', token }, new FakeConn());
    expect(r.ok).toBe(false);
  });
});

describe('playback commands', () => {
  it('anchors play at the initiator’s click time, not arrival time', async () => {
    const { room, join } = setup();
    const a = join('Ana');
    load(room, a.m);
    await new Promise((r) => setTimeout(r, 80)); // the click must come after the last state change
    const clickedAt = serverNow() - 40;
    room.handle(a.m, { t: 'cmd', cmdId: 'c1', kind: 'play', position: 0, issuedAt: clickedAt, baseVersion: room.playback.version });
    expect(room.playback.status).toBe('playing');
    expect(Math.abs(room.playback.at - clickedAt)).toBeLessThan(1);
  });

  it('clamps forged / skewed click times into [now − 1 s, now]', () => {
    const { room, join } = setup();
    const a = join('Ana');
    load(room, a.m);
    room.handle(a.m, { t: 'cmd', cmdId: 'c1', kind: 'play', position: 0, issuedAt: serverNow() + 60_000, baseVersion: room.playback.version });
    expect(room.playback.at).toBeLessThanOrEqual(serverNow());
  });

  it('pauses everyone on the initiator’s exact frame', () => {
    const { room, join } = setup();
    const a = join('Ana');
    load(room, a.m);
    room.handle(a.m, { t: 'cmd', cmdId: 'c1', kind: 'play', position: 0, issuedAt: serverNow() - 1500, baseVersion: room.playback.version });
    room.handle(a.m, { t: 'cmd', cmdId: 'c2', kind: 'pause', position: 1.4567, issuedAt: serverNow(), baseVersion: room.playback.version });
    expect(room.playback.position).toBe(1.4567);
  });

  it('collapses simultaneous pauses into one (second is a no-op)', () => {
    const { room, join } = setup();
    const a = join('Ana');
    const b = join('Ben');
    load(room, a.m);
    room.handle(a.m, { t: 'cmd', cmdId: 'p', kind: 'play', position: 0, issuedAt: serverNow(), baseVersion: room.playback.version });
    const base = room.playback.version;
    room.handle(a.m, { t: 'cmd', cmdId: 'x', kind: 'pause', position: 1, issuedAt: serverNow(), baseVersion: base });
    room.handle(b.m, { t: 'cmd', cmdId: 'y', kind: 'pause', position: 1, issuedAt: serverNow(), baseVersion: base });
    expect(room.playback.version).toBe(base + 1);
    expect(b.conn.last('cmdResult')).toMatchObject({ cmdId: 'y', ok: true, noop: true });
  });

  it('racing seeks: last arrival wins and is flagged as concurrent', () => {
    const { room, join } = setup();
    const a = join('Ana');
    const b = join('Ben');
    load(room, a.m);
    const base = room.playback.version;
    room.handle(a.m, { t: 'cmd', cmdId: 'x', kind: 'seek', position: 100, issuedAt: serverNow(), baseVersion: base });
    room.handle(b.m, { t: 'cmd', cmdId: 'y', kind: 'seek', position: 200, issuedAt: serverNow(), baseVersion: base });
    expect(room.playback.position).toBe(200);
    expect(room.playback.concurrentWith).toBe('Ana');
    // every member saw the same final version
    const finals = [a, b].map(({ conn }) => conn.events().filter((e) => e.e === 'playback').at(-1));
    expect(finals[0]).toEqual(finals[1]);
  });

  it('host-only mode refuses members; democracy mode turns presses into votes', () => {
    const host = setup('host');
    const h = host.join('Ana');
    const m = host.join('Ben');
    load(host.room, h.m);
    host.room.handle(m.m, { t: 'cmd', cmdId: 'z', kind: 'play', position: 0, issuedAt: serverNow(), baseVersion: host.room.playback.version });
    expect(host.room.playback.status).toBe('paused');
    expect(m.conn.last('cmdResult')?.ok).toBe(false);

    const demo = setup('democracy');
    const a = demo.join('Ana');
    const b = demo.join('Ben');
    const c = demo.join('Cy');
    load(demo.room, a.m);
    demo.room.handle(b.m, { t: 'cmd', cmdId: 'v', kind: 'play', position: 0, issuedAt: serverNow(), baseVersion: demo.room.playback.version });
    expect(demo.room.votes).toHaveLength(1);
    expect(demo.room.playback.status).toBe('paused');
    demo.room.handle(c.m, { t: 'vote', voteId: demo.room.votes[0].id, yes: true });
    expect(demo.room.playback.status).toBe('playing');
  });
});

describe('chat, playlist, polls, group pick', () => {
  it('chat retries with the same id are idempotent', () => {
    const { room, join } = setup();
    const a = join('Ana');
    room.handle(a.m, { t: 'chat', id: 'same', text: 'hi', mediaTime: null });
    room.handle(a.m, { t: 'chat', id: 'same', text: 'hi', mediaTime: null });
    expect(room.chat.filter((c) => c.id === 'same')).toHaveLength(1);
  });

  it('playlist moves are anchor-relative', () => {
    const { room, join } = setup();
    const a = join('Ana');
    for (const t of ['one', 'two', 'three']) room.handle(a.m, { t: 'pl', op: 'add', media: { kind: 'file', title: t, url: `https://e.com/${t}.mp4` } });
    const [one, , three] = room.playlist;
    room.handle(a.m, { t: 'pl', op: 'move', itemId: one.id, afterId: three.id });
    expect(room.playlist.map((i) => i.media.title)).toEqual(['two', 'three', 'one']);
    room.handle(a.m, { t: 'pl', op: 'move', itemId: one.id, afterId: null });
    expect(room.playlist.map((i) => i.media.title)).toEqual(['one', 'two', 'three']);
  });

  it('poll winner can be queued automatically', () => {
    const { room, join } = setup();
    const a = join('Ana');
    const b = join('Ben');
    room.handle(a.m, { t: 'poll', op: 'create', question: 'Next?', options: [{ label: 'A', movieId: 'a' }, { label: 'B', movieId: 'b' }], multi: false, anonymous: false, durationSec: 0, action: 'queue' });
    const poll = room.polls[0];
    room.handle(a.m, { t: 'poll', op: 'vote', pollId: poll.id, optionIds: [poll.options[1].id] });
    room.handle(b.m, { t: 'poll', op: 'vote', pollId: poll.id, optionIds: [poll.options[1].id] });
    expect(poll.closed).toBe(true); // everyone voted → auto-close
    expect(poll.winner).toBe(poll.options[1].id);
    expect(room.playlist.some((i) => i.media.movieId === 'b')).toBe(true);
  });

  it('group pick matches on the first unanimous like and queues it', () => {
    const { room, join } = setup();
    const a = join('Ana');
    const b = join('Ben');
    room.handle(a.m, { t: 'pick', op: 'start' });
    expect(room.pick?.status).toBe('active');
    room.handle(a.m, { t: 'pick', op: 'swipe', movieId: 'a', like: false });
    room.handle(a.m, { t: 'pick', op: 'swipe', movieId: 'b', like: true });
    room.handle(b.m, { t: 'pick', op: 'swipe', movieId: 'a', like: true });
    expect(room.pick?.status).toBe('active');
    room.handle(b.m, { t: 'pick', op: 'swipe', movieId: 'b', like: true });
    expect(room.pick?.status).toBe('matched');
    expect(room.pick?.match).toBe('b');
    expect(room.playlist.some((i) => i.media.movieId === 'b')).toBe(true);
    // swipes feed the room's taste profile for the recommender
    expect(room.tastes().find((t) => t.name === 'Ana')?.dislikes).toContain('a');
  });
});

describe('persistence', () => {
  it('round-trips a room through JSON (server restart) keeping identities and playback', () => {
    const { room, join } = setup();
    const a = join('Ana');
    load(room, a.m);
    room.handle(a.m, { t: 'cmd', cmdId: 'c1', kind: 'play', position: 0, issuedAt: serverNow(), baseVersion: room.playback.version });
    const restored = Room.fromJSON(JSON.parse(JSON.stringify(room.toJSON())), { catalog: fakeCatalog, chaosEnabled: true, cap: 50 });
    expect(restored.playback.status).toBe('playing');
    expect(restored.playback.at).toBe(room.playback.at);
    const token = a.conn.last('welcome')!.token;
    const r = restored.join({ t: 'hello', v: 1, room: 'ABCDEF', name: 'Ana', avatar: '🙂', color: '#ffffff', device: 'desktop', token }, new FakeConn());
    expect(r.ok && r.member.role).toBe('host');
  });
});

describe('new: speed, stats, ratings, voice relay', () => {
  it('synced speed re-anchors without a jump and survives pause/play', async () => {
    const { room, join } = setup();
    const a = join('Ana');
    load(room, a.m);
    await new Promise((r) => setTimeout(r, 30));
    room.handle(a.m, { t: 'cmd', cmdId: 'p', kind: 'play', position: 0, issuedAt: serverNow(), baseVersion: room.playback.version });
    await new Promise((r) => setTimeout(r, 200));
    const before = room.playback.position + (serverNow() - room.playback.at) / 1000;
    room.handle(a.m, { t: 'speed', rate: 1.3 });
    expect(room.playback.rate).toBe(1.25); // snapped to the menu
    expect(Math.abs(room.playback.position - before)).toBeLessThan(0.05); // continuous
    room.handle(a.m, { t: 'cmd', cmdId: 'x', kind: 'pause', position: room.playback.position, issuedAt: serverNow(), baseVersion: room.playback.version });
    room.handle(a.m, { t: 'cmd', cmdId: 'y', kind: 'play', position: room.playback.position, issuedAt: serverNow(), baseVersion: room.playback.version });
    expect(room.playback.rate).toBe(1.25);
  });

  it('collects per-film stats: moments, reactions, chat; ratings post a verdict and teach taste', () => {
    const { room, join } = setup();
    const a = join('Ana');
    const b = join('Ben');
    room.handle(a.m, { t: 'pl', op: 'addMovie', movieId: 'a' });
    const media = room.playback.media!;
    room.handle(a.m, { t: 'react', emoji: '🔥', mediaTime: 12 });
    room.handle(b.m, { t: 'react', emoji: '🔥', mediaTime: 13 });
    room.handle(b.m, { t: 'react', emoji: '😂', mediaTime: 61 });
    room.handle(b.m, { t: 'chat', id: 'c1', text: 'lol', mediaTime: 61 });
    const s = room.stats.find((x) => x.mediaId === media.id)!;
    expect(s.moments[2]['🔥']).toBe(2);
    expect(s.reactions[b.m.id]).toEqual({ '🔥': 1, '😂': 1 });
    expect(s.chat[b.m.id]).toBe(1);
    room.handle(a.m, { t: 'rating', mediaId: media.id, stars: 5 });
    expect(room.chat.some((c) => c.text.startsWith('⭐'))).toBe(false); // not everyone yet
    room.handle(b.m, { t: 'rating', mediaId: media.id, stars: 2 });
    expect(room.chat.some((c) => c.text.includes('Room verdict') && c.text.includes('3.5/5'))).toBe(true);
    expect(room.tastes().find((t) => t.name === 'Ana')?.likes).toContain('a');
    expect(room.tastes().find((t) => t.name === 'Ben')?.dislikes).toContain('a');
  });

  it('relays WebRTC signalling only to the addressed peer, and only inside voice', () => {
    const { room, join } = setup();
    const a = join('Ana');
    const b = join('Ben');
    const c = join('Cy');
    const offer = { t: 'rtc' as const, to: b.m.id, data: { type: 'offer' as const, sdp: 'v=0' } };
    room.handle(a.m, offer);
    expect(b.conn.last('rtc')).toBeUndefined(); // nobody in voice yet
    room.handle(a.m, { t: 'voice', on: true, mic: true });
    room.handle(b.m, { t: 'voice', on: true, mic: false });
    expect(b.m.voice).toBe('listen');
    room.handle(a.m, offer);
    expect(b.conn.last('rtc')).toMatchObject({ from: a.m.id, data: { type: 'offer' } });
    expect(c.conn.last('rtc')).toBeUndefined();
    // a listener can't "speak"; a talker's speaking flag reaches everyone else
    room.handle(b.m, { t: 'speaking', on: true });
    expect(c.conn.last('speaking')).toBeUndefined();
    room.handle(a.m, { t: 'speaking', on: true });
    expect(c.conn.last('speaking')).toMatchObject({ memberId: a.m.id, on: true });
    expect(a.conn.last('speaking')).toBeUndefined();
    // dropping out of the socket drops you out of voice (peers tear down)
    room.detach(a.m, a.conn, false);
    expect(a.m.voice).toBe('off');
  });

  it('ghost-scrub and pointer frames go to everyone but the sender', () => {
    const { room, join } = setup();
    const a = join('Ana');
    const b = join('Ben');
    room.handle(a.m, { t: 'hover', time: 42 });
    room.handle(a.m, { t: 'pointer', x: 0.5, y: 0.25, mode: 'laser', end: false });
    expect(b.conn.last('hover')).toMatchObject({ memberId: a.m.id, time: 42 });
    expect(b.conn.last('pointer')).toMatchObject({ memberId: a.m.id, x: 0.5, y: 0.25 });
    expect(a.conn.last('hover')).toBeUndefined();
  });
});
