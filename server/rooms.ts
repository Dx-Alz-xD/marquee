// Room registry: creation, ticking, crash-safe persistence, garbage collection.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomRoomCode } from '../shared/util';
import { Room, type RoomDeps, type RoomSettings } from './room';

const DATA_DIR = new URL('../data/', import.meta.url);
const FILE = new URL('rooms.json', DATA_DIR);
const TMP = new URL('rooms.json.tmp', DATA_DIR);
const EMPTY_TTL_MS = 6 * 60 * 60 * 1000;
/** PERSIST=0 disables snapshots (benchmarks / throwaway instances). */
const PERSIST = process.env.PERSIST !== '0';

export class RoomManager {
  rooms = new Map<string, Room>();
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly deps: RoomDeps) {
    if (PERSIST) this.restore();
    this.timers.push(setInterval(() => this.tick(), 100));
    this.timers.push(setInterval(() => this.save(), 5000));
    this.timers.push(setInterval(() => this.gc(), 60_000));
  }

  create(settings: Partial<RoomSettings>): Room {
    let code = randomRoomCode();
    while (this.rooms.has(code)) code = randomRoomCode();
    const room = new Room(
      code,
      {
        name: settings.name?.trim() || 'Movie night',
        controlMode: settings.controlMode ?? 'everyone',
        syncPolicy: settings.syncPolicy ?? 'strict',
        autoplayNext: settings.autoplayNext ?? true,
        passcode: settings.passcode?.trim() || null,
      },
      this.deps,
    );
    this.rooms.set(code, room);
    return room;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code.toUpperCase());
  }

  private tick() {
    for (const r of this.rooms.values()) {
      try {
        r.tick();
      } catch (e) {
        console.error(`[room ${r.code}] tick failed`, e);
      }
    }
  }

  /** Atomic write (tmp + rename) so a crash mid-write can't corrupt the snapshot. */
  save(force = false) {
    if (!PERSIST) return;
    const dirty = [...this.rooms.values()].some((r) => r.dirty);
    if (!dirty && !force) return;
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(TMP, JSON.stringify({ savedAt: Date.now(), rooms: [...this.rooms.values()].map((r) => r.toJSON()) }));
      renameSync(TMP, FILE);
      for (const r of this.rooms.values()) r.dirty = false;
    } catch (e) {
      console.error('[rooms] save failed', e);
    }
  }

  private restore() {
    if (!existsSync(FILE)) return;
    try {
      const data = JSON.parse(readFileSync(FILE, 'utf8')) as { rooms: ReturnType<Room['toJSON']>[] };
      for (const r of data.rooms) this.rooms.set(r.code, Room.fromJSON(r, this.deps));
      if (data.rooms.length) console.log(`[rooms] restored ${data.rooms.length} room(s) from disk`);
    } catch (e) {
      console.error('[rooms] could not restore snapshot — starting fresh', e);
    }
  }

  private gc() {
    const t = Date.now();
    for (const [code, r] of this.rooms) {
      if (r.onlineCount === 0 && r.emptySince && t - r.emptySince > EMPTY_TTL_MS) this.rooms.delete(code);
    }
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.save(true);
  }
}
