// ─────────────────────────────────────────────────────────────────────────────
// Wire protocol v1. Client → server messages are validated with zod at the
// gateway; server → client messages are typed only (we trust ourselves).
// ─────────────────────────────────────────────────────────────────────────────
import { z } from 'zod';
import type {
  ChatMessage,
  ControlVote,
  LatencySummary,
  MediaStats,
  Member,
  MemberTelemetry,
  PickSession,
  PlaybackState,
  PlaylistItem,
  Poll,
  PublicSettings,
  RoomSnapshot,
  UpNext,
} from './types';

export const PROTOCOL_VERSION = 1;

const id = z.string().min(1).max(64);
const num = z.number().finite();
const text = (max: number) => z.string().max(max);

export const LocalFileSchema = z.object({
  name: text(260),
  size: z.number().int().nonnegative(),
  fingerprint: z.string().regex(/^[a-f0-9]{16,64}$/),
  duration: num.nullable().optional(),
});

export const MediaInputSchema = z.object({
  kind: z.enum(['youtube', 'file', 'hls', 'local']),
  title: text(200).min(1),
  // Absolute http(s) URL, or a file uploaded to this server (resolved against each viewer's own origin).
  url: z
    .string()
    .max(2048)
    .refine((s) => /^https?:\/\//i.test(s) || s.startsWith('/media/'), 'must be an http(s) URL')
    .optional(),
  youtubeId: z.string().regex(/^[A-Za-z0-9_-]{11}$/).optional(),
  thumbnail: z.string().url().max(2048).nullable().optional(),
  duration: num.nullable().optional(),
  movieId: z.string().max(64).nullable().optional(),
  local: LocalFileSchema.optional(),
});
export type MediaInput = z.infer<typeof MediaInputSchema>;

const Hello = z.object({
  t: z.literal('hello'),
  v: z.number().int(),
  room: z.string().min(4).max(12),
  name: text(32).min(1),
  avatar: text(16).min(1),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  token: z.string().max(128).optional(),
  lastSeq: z.number().int().nonnegative().optional(),
  passcode: text(64).optional(),
  device: z.enum(['desktop', 'mobile']).default('desktop'),
});

const Ping = z.object({ t: z.literal('ping'), c0: num });

const Cmd = z.object({
  t: z.literal('cmd'),
  cmdId: id,
  kind: z.enum(['play', 'pause', 'seek']),
  position: num.min(0),
  issuedAt: num,
  baseVersion: z.number().int().nonnegative(),
});

const Countdown = z.object({ t: z.literal('countdown'), seconds: z.number().int().min(1).max(10).default(3) });

const Ack = z.object({
  t: z.literal('ack'),
  version: z.number().int(),
  recvAt: num,
  appliedAt: num,
});

const Report = z.object({
  t: z.literal('report'),
  player: z.enum(['idle', 'loading', 'ready', 'buffering', 'error', 'needs-file', 'detour', 'blocked']),
  drift: num.nullable(),
  rtt: num.nullable(),
  offset: num.nullable(),
  rate: num.nullable(),
  away: z.boolean(),
  duration: z.object({ mediaId: id, duration: num.positive() }).optional(),
  localFingerprint: z.string().max(64).nullable().optional(),
});

const Ended = z.object({ t: z.literal('ended'), mediaId: id });

const Chat = z.object({
  t: z.literal('chat'),
  id,
  text: text(500).min(1),
  replyTo: id.nullable().optional(),
  mediaTime: num.nullable(),
});

const ChatReact = z.object({ t: z.literal('chatReact'), msgId: id, emoji: text(16).min(1) });
const Typing = z.object({ t: z.literal('typing') });
const React = z.object({ t: z.literal('react'), emoji: text(16).min(1), mediaTime: num.nullable() });

const Playlist = z.discriminatedUnion('op', [
  z.object({ t: z.literal('pl'), op: z.literal('add'), media: MediaInputSchema, next: z.boolean().optional() }),
  z.object({ t: z.literal('pl'), op: z.literal('addMovie'), movieId: id, next: z.boolean().optional(), playNow: z.boolean().optional() }),
  z.object({ t: z.literal('pl'), op: z.literal('remove'), itemId: id }),
  z.object({ t: z.literal('pl'), op: z.literal('move'), itemId: id, afterId: id.nullable() }),
  z.object({ t: z.literal('pl'), op: z.literal('play'), itemId: id }),
  z.object({ t: z.literal('pl'), op: z.literal('next') }),
  z.object({ t: z.literal('pl'), op: z.literal('cancelNext') }),
]);

const PollMsg = z.discriminatedUnion('op', [
  z.object({
    t: z.literal('poll'),
    op: z.literal('create'),
    question: text(200).min(1),
    options: z
      .array(z.object({ label: text(120).min(1), movieId: id.nullable().optional(), itemId: id.nullable().optional() }))
      .min(2)
      .max(8),
    multi: z.boolean().default(false),
    anonymous: z.boolean().default(false),
    durationSec: z.number().int().min(0).max(3600).default(0),
    action: z.enum(['none', 'queue', 'play']).default('none'),
  }),
  z.object({ t: z.literal('poll'), op: z.literal('vote'), pollId: id, optionIds: z.array(id).max(8) }),
  z.object({ t: z.literal('poll'), op: z.literal('close'), pollId: id }),
]);

const Vote = z.object({ t: z.literal('vote'), voteId: id, yes: z.boolean() });

const Role = z.object({
  t: z.literal('role'),
  op: z.enum(['transfer', 'cohost', 'demote', 'kick']),
  target: id,
});

const Settings = z.object({
  t: z.literal('settings'),
  patch: z
    .object({
      name: text(60).min(1),
      controlMode: z.enum(['host', 'everyone', 'democracy']),
      syncPolicy: z.enum(['strict', 'relaxed']),
      autoplayNext: z.boolean(),
    })
    .partial(),
});

const Pick = z.discriminatedUnion('op', [
  z.object({ t: z.literal('pick'), op: z.literal('start'), movieIds: z.array(id).max(30).optional() }),
  z.object({ t: z.literal('pick'), op: z.literal('swipe'), movieId: id, like: z.boolean() }),
  z.object({ t: z.literal('pick'), op: z.literal('end') }),
]);

const Browse = z.object({ t: z.literal('browse'), movieId: id.nullable() });
const Suggest = z.object({ t: z.literal('suggest'), movieId: id });
const Profile = z.object({
  t: z.literal('profile'),
  name: text(32).min(1),
  avatar: text(16).min(1),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});

const Chaos = z.object({
  t: z.literal('chaos'),
  target: id,
  lagMs: z.number().int().min(0).max(3000).optional(),
  jitterMs: z.number().int().min(0).max(1000).optional(),
  action: z.enum(['set', 'drop', 'jump', 'clear']).default('set'),
  seconds: z.number().min(-10).max(10).optional(),
});

const Leave = z.object({ t: z.literal('leave') });

/** Synced playback speed for the whole room. */
const Speed = z.object({ t: z.literal('speed'), rate: z.number().min(0.5).max(2) });
/** Ghost scrubbing: where I'm hovering on the seek bar (null = stopped). Ephemeral. */
const Hover = z.object({ t: z.literal('hover'), time: num.min(0).nullable() });
/** Laser pointer / drawing on the shared screen, normalised 0..1 coordinates. Ephemeral. */
const Pointer = z.object({
  t: z.literal('pointer'),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  mode: z.enum(['laser', 'draw']),
  end: z.boolean().default(false),
});
const Rating = z.object({ t: z.literal('rating'), mediaId: id, stars: z.number().int().min(1).max(5) });

// ─── Voice (WebRTC mesh; the server only relays signalling) ───
const Voice = z.object({ t: z.literal('voice'), on: z.boolean(), mic: z.boolean() });
export const RtcDataSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('offer'), sdp: z.string().max(30_000) }),
  z.object({ type: z.literal('answer'), sdp: z.string().max(30_000) }),
  z.object({
    type: z.literal('ice'),
    candidate: z.object({
      candidate: z.string().max(2000),
      sdpMid: z.string().max(64).nullable().optional(),
      sdpMLineIndex: z.number().int().nullable().optional(),
      usernameFragment: z.string().max(256).nullable().optional(),
    }),
  }),
  z.object({ type: z.literal('bye') }),
]);
export type RtcData = z.infer<typeof RtcDataSchema>;
const Rtc = z.object({ t: z.literal('rtc'), to: id, data: RtcDataSchema });
const Speaking = z.object({ t: z.literal('speaking'), on: z.boolean() });

export const ClientMsgSchema = z.union([
  Hello,
  Ping,
  Cmd,
  Countdown,
  Ack,
  Report,
  Ended,
  Chat,
  ChatReact,
  Typing,
  React,
  Playlist,
  PollMsg,
  Vote,
  Role,
  Settings,
  Pick,
  Browse,
  Suggest,
  Profile,
  Chaos,
  Leave,
  Speed,
  Hover,
  Pointer,
  Rating,
  Voice,
  Rtc,
  Speaking,
]);

export type ClientMsg = z.infer<typeof ClientMsgSchema>;
export type HelloMsg = z.infer<typeof Hello>;
export type CmdMsg = z.infer<typeof Cmd>;
export type ReportMsg = z.infer<typeof Report>;
export type PlaylistMsg = z.infer<typeof Playlist>;
export type PollClientMsg = z.infer<typeof PollMsg>;
export type PickMsg = z.infer<typeof Pick>;
export type ChaosMsg = z.infer<typeof Chaos>;
export type PointerMsg = z.infer<typeof Pointer>;

// ─── Server → client ─────────────────────────────────────────────────────────

/** Sequenced room events. Every one is idempotent "state patch" so replay after resume is safe. */
export type RoomEvent =
  | { e: 'playback'; playback: PlaybackState }
  | { e: 'member'; member: Member }
  | { e: 'memberLeft'; id: string; name: string }
  | { e: 'chat'; message: ChatMessage }
  | { e: 'chatUpdate'; message: ChatMessage }
  | { e: 'playlist'; playlist: PlaylistItem[] }
  | { e: 'poll'; poll: Poll }
  | { e: 'pollRemoved'; id: string }
  | { e: 'vote'; vote: ControlVote }
  | { e: 'voteRemoved'; id: string }
  | { e: 'settings'; settings: PublicSettings }
  | { e: 'pick'; pick: PickSession | null }
  | { e: 'upNext'; upNext: UpNext | null }
  | { e: 'toast'; text: string; tone: 'info' | 'warn' | 'success'; icon?: string };

export type ServerMsg =
  | {
      t: 'welcome';
      you: string;
      token: string;
      snapshot: RoomSnapshot;
      seq: number;
      serverTime: number;
      resumed: boolean;
      chaosEnabled: boolean;
    }
  | { t: 'resumed'; replayed: number; seq: number; serverTime: number }
  | { t: 'ev'; seq: number; ev: RoomEvent }
  | { t: 'pong'; c0: number; s1: number; s2: number }
  | { t: 'reactions'; items: { memberId: string; emoji: string; mediaTime: number | null }[] }
  | { t: 'heat'; mediaId: string; bins: number[] }
  | { t: 'typing'; memberId: string }
  | { t: 'telemetry'; members: MemberTelemetry[]; latency: LatencySummary }
  | { t: 'cmdResult'; cmdId: string; ok: boolean; noop?: boolean; reason?: string; version: number }
  | { t: 'chaos'; action: 'jump'; seconds: number }
  | { t: 'myPick'; swipes: Record<string, boolean> }
  | { t: 'hover'; memberId: string; time: number | null }
  | { t: 'pointer'; memberId: string; x: number; y: number; mode: 'laser' | 'draw'; end: boolean }
  | { t: 'stats'; stats: MediaStats }
  | { t: 'rtc'; from: string; data: RtcData }
  | { t: 'speaking'; memberId: string; on: boolean }
  | { t: 'error'; code: string; message: string; fatal?: boolean };
