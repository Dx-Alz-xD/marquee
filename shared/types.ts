// ─────────────────────────────────────────────────────────────────────────────
// Domain model shared by server, web client and the benchmark bots.
// All times named `at`, `ts`, `issuedAt`, `endsAt`… are SERVER-clock epoch ms.
// All media positions are seconds.
// ─────────────────────────────────────────────────────────────────────────────

export type MediaKind = 'youtube' | 'file' | 'hls' | 'local';

/** A file each participant supplies themselves; matched by fingerprint. */
export interface LocalFileInfo {
  name: string;
  size: number;
  /** sha-256 over size + first/last 1 MiB — cheap, collision-resistant enough to detect "same file". */
  fingerprint: string;
  duration?: number | null;
}

export interface Media {
  /** Unique per playlist entry (the same movie can be queued twice). */
  id: string;
  kind: MediaKind;
  title: string;
  url?: string;
  youtubeId?: string;
  thumbnail?: string | null;
  duration?: number | null;
  movieId?: string | null;
  local?: LocalFileInfo;
}

export type PlaybackCause =
  | 'init'
  | 'load'
  | 'play'
  | 'pause'
  | 'seek'
  | 'hold'
  | 'resume'
  | 'end'
  | 'countdown'
  | 'vote';

/**
 * Playback is never "the current time". It is an anchor: the media position at
 * a known server instant. Everyone derives where they should be from it:
 *   expected(now) = playing ? position + (now − at)/1000 × rate : position
 * `at` in the future ⇒ a scheduled (countdown) start.
 */
export interface PlaybackState {
  media: Media | null;
  status: 'playing' | 'paused';
  position: number;
  at: number;
  rate: number;
  version: number;
  by: string | null;
  byName: string | null;
  cause: PlaybackCause;
  cmdId: string | null;
  /** Initiator's click time (server clock) — used for propagation-latency measurement. */
  issuedAt: number | null;
  /** Set when this command raced another member's command (name of the one it superseded). */
  concurrentWith: string | null;
  /** Strict sync policy: room is paused waiting for these members to finish buffering. */
  hold: { waitingFor: string[]; since: number } | null;
  ended: boolean;
}

export type Role = 'host' | 'cohost' | 'member';
export type PlayerStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'buffering'
  | 'error'
  | 'needs-file'
  | 'detour'
  | 'blocked';

export interface Member {
  id: string;
  name: string;
  avatar: string;
  color: string;
  role: Role;
  online: boolean;
  joinedAt: number;
  seat: number;
  player: PlayerStatus;
  away: boolean;
  browsing: string | null;
  device: 'desktop' | 'mobile';
  /** Fingerprint of the local file this member picked (local-file mode). */
  localFingerprint: string | null;
  /** Voice channel: off, listening only (no mic / insecure origin), or able to talk. */
  voice: 'off' | 'listen' | 'talk';
}

export interface ChaosConfig {
  lagMs: number;
  jitterMs: number;
}

export interface MemberTelemetry {
  id: string;
  drift: number | null; // ms, actual − expected
  rtt: number | null; // ms
  offset: number | null; // ms, server − client clock
  rate: number | null; // current playbackRate (correction in progress if ≠ 1)
  chaos: ChaosConfig | null;
}

export interface LatencySummary {
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  deliveryP95: number | null;
  applyP95: number | null;
  driftP95: number | null;
  recent: LatencySample[];
}

export interface LatencySample {
  kind: string;
  to: string;
  total: number; // click on A → applied on B
  delivery: number; // click on A → received by B
  apply: number; // received by B → player call returned
  at: number;
}

export interface MovieCard {
  type: 'movie';
  movieId: string;
  title: string;
  poster: string | null;
  year: number | null;
  reason?: string | null;
}

export interface ChatMessage {
  id: string;
  kind: 'user' | 'system';
  memberId: string | null;
  name: string;
  color: string;
  avatar: string;
  text: string;
  ts: number;
  mediaTime: number | null;
  replyTo: { id: string; name: string; text: string } | null;
  reactions: Record<string, string[]>;
  card: MovieCard | null;
}

export interface PlaylistItem {
  id: string;
  media: Media;
  addedBy: string;
  addedByName: string;
  addedAt: number;
}

export interface PollOption {
  id: string;
  label: string;
  movieId?: string | null;
  media?: Media | null;
}

export interface Poll {
  id: string;
  question: string;
  options: PollOption[];
  multi: boolean;
  anonymous: boolean;
  action: 'none' | 'queue' | 'play';
  createdBy: string;
  createdByName: string;
  createdAt: number;
  endsAt: number | null;
  closed: boolean;
  tally: Record<string, number>;
  /** optionId → member ids. null when the poll is anonymous. */
  voters: Record<string, string[]> | null;
  totalVoters: number;
  winner: string | null;
}

export type ControlVoteKind = 'play' | 'pause' | 'seek' | 'skip';

export interface ControlVote {
  id: string;
  kind: ControlVoteKind;
  position: number | null;
  by: string;
  byName: string;
  yes: string[];
  no: string[];
  needed: number;
  endsAt: number;
  resolved: 'passed' | 'failed' | null;
}

export interface PickResult {
  movieId: string;
  likes: number;
  dislikes: number;
  likedBy: string[];
}

export interface PickSession {
  id: string;
  candidates: string[];
  reasons: Record<string, string | null>;
  participants: string[];
  progress: Record<string, number>;
  status: 'active' | 'matched' | 'done';
  match: string | null;
  startedBy: string;
  startedByName: string;
  startedAt: number;
  /** Revealed only once the session ends. */
  results: PickResult[] | null;
}

export interface UpNext {
  itemId: string;
  at: number;
}

export interface PublicSettings {
  name: string;
  controlMode: 'host' | 'everyone' | 'democracy';
  syncPolicy: 'strict' | 'relaxed';
  autoplayNext: boolean;
  hasPasscode: boolean;
}

export interface RoomSnapshot {
  code: string;
  createdAt: number;
  settings: PublicSettings;
  members: Member[];
  playback: PlaybackState;
  playlist: PlaylistItem[];
  chat: ChatMessage[];
  polls: Poll[];
  votes: ControlVote[];
  pick: PickSession | null;
  upNext: UpNext | null;
  heatmap: Record<string, number[]>;
  /** Tonight's lineup: one entry per film watched in this room (most recent last). */
  stats: MediaStats[];
}

// ─── Movie catalog ───────────────────────────────────────────────────────────

export interface Movie {
  id: string;
  title: string;
  year: number | null;
  overview: string;
  tagline?: string | null;
  genres: string[];
  runtime: number | null;
  rating: number | null;
  votes: number;
  popularity: number;
  language: string;
  director: string | null;
  cast: string[];
  keywords: string[];
  poster: string | null;
  backdrop: string | null;
  /** YouTube id of the trailer. */
  trailer: string | null;
  /** A full, legally free stream (public domain / open movies). */
  playable: { kind: 'file' | 'hls'; url: string } | null;
  source: 'tmdb' | 'archive' | 'open';
  moods?: string[];
}

export interface MovieHit extends Movie {
  score?: number;
  reason?: string | null;
}

export interface Shelf {
  id: string;
  title: string;
  subtitle?: string;
  movies: MovieHit[];
}

export const HEAT_BIN_SECONDS = 5;

/**
 * Everything the room did during one film — the raw material for the Movie
 * Night Wrap (top moments, awards, ratings) and the late-joiner catch-up.
 */
export interface MediaStats {
  mediaId: string;
  title: string;
  thumbnail: string | null;
  movieId: string | null;
  startedAt: number;
  endedAt: number | null;
  /** Peak position reached (s) and duration if known. */
  watchedTo: number;
  /** Wall-clock seconds the room actually spent playing this film together. */
  togetherSecs: number;
  duration: number | null;
  /** heat bin index → emoji → count */
  moments: Record<number, Record<string, number>>;
  /** memberId → emoji → count */
  reactions: Record<string, Record<string, number>>;
  chat: Record<string, number>;
  commands: Record<string, number>;
  /** memberId → summed |drift| ms and sample count (for the "Sync sniper" award). */
  drift: Record<string, { sum: number; n: number }>;
  ratings: Record<string, number>;
  /** Who was there (kept even after they leave). */
  people: Record<string, { name: string; avatar: string; color: string }>;
}
