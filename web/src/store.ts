// Client state. Server events are idempotent patches, so applying a replayed
// event twice (after a resume) is harmless.
import { create } from 'zustand';
import type { RoomEvent } from '@shared/protocol';
import type {
  ChatMessage,
  ControlVote,
  LatencySummary,
  MediaStats,
  Member,
  MemberTelemetry,
  PickSession,
  PlaybackState,
  PlayerStatus,
  PlaylistItem,
  Poll,
  PublicSettings,
  RoomSnapshot,
  UpNext,
} from '@shared/types';
import { uid } from '@shared/util';

export interface Toast {
  id: string;
  text: string;
  tone: 'info' | 'warn' | 'success' | 'error';
  icon?: string;
}
export interface Floater {
  id: string;
  emoji: string;
  memberId: string;
  sway: number;
}
export interface Combo {
  id: string;
  emoji: string;
  count: number;
}

export interface LocalPlayer {
  status: PlayerStatus;
  drift: number | null; // ms
  rate: number;
  detour: boolean;
  blocked: boolean;
  muted: boolean;
  volume: number;
  seekLead: number; // s
  time: number;
  duration: number | null;
  error: string | null;
  /** The room's synced speed (corrections multiply on top). */
  baseRate: number;
  /** Movie volume lowered because someone is talking. */
  ducked: boolean;
}

export interface VoiceLocal {
  state: 'off' | 'connecting' | 'listen' | 'talk';
  /** Push-to-talk held or hands-free latched. */
  transmitting: boolean;
  handsFree: boolean;
  error: string | null;
  peers: Record<string, 'connecting' | 'connected' | 'failed'>;
}

export type Tab = 'chat' | 'queue' | 'polls' | 'people';

export interface UiState {
  tab: Tab;
  discover: boolean;
  lab: boolean;
  invite: boolean;
  settings: boolean;
  pick: boolean;
  replyTo: ChatMessage | null;
  movieId: string | null;
  /** mediaId whose Movie Night Wrap is open */
  wrap: string | null;
  draw: boolean;
}

interface State {
  conn: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed';
  fatal: { code: string; message: string } | null;
  needPasscode: string | null;
  you: string | null;
  chaosEnabled: boolean;
  code: string;
  createdAt: number;
  settings: PublicSettings | null;
  members: Record<string, Member>;
  playback: PlaybackState | null;
  playlist: PlaylistItem[];
  chat: ChatMessage[];
  polls: Poll[];
  votes: ControlVote[];
  pick: PickSession | null;
  upNext: UpNext | null;
  heatmap: Record<string, number[]>;
  stats: MediaStats[];
  hovers: Record<string, { time: number; at: number }>;
  speaking: Record<string, boolean>;
  voice: VoiceLocal;
  /** Late-joiner catch-up card (computed once on first welcome). */
  catchup: { joinedAt: number; mediaId: string; position: number } | null;
  telemetry: Record<string, MemberTelemetry>;
  driftHistory: Record<string, number[]>;
  latency: LatencySummary | null;
  clock: { rtt: number; offset: number; jitter: number; synced: boolean };
  typing: Record<string, number>;
  myPick: Record<string, boolean>;
  myVotes: Record<string, string[]>;
  local: LocalPlayer;
  localFile: { name: string; size: number; fingerprint: string; url: string; acceptedFor: string | null } | null;
  toasts: Toast[];
  floaters: Floater[];
  combos: Combo[];
  ui: UiState;
  unread: number;
}

interface Actions {
  reset(code: string): void;
  applySnapshot(you: string, s: RoomSnapshot, chaosEnabled: boolean): void;
  applyEvent(ev: RoomEvent): void;
  setTelemetry(members: MemberTelemetry[], latency: LatencySummary): void;
  addReactions(items: { memberId: string; emoji: string }[]): void;
  toast(text: string, tone?: Toast['tone'], icon?: string): void;
  dismissToast(id: string): void;
  setLocal(p: Partial<LocalPlayer>): void;
  setUi(p: Partial<UiState>): void;
  setStats(st: MediaStats): void;
  setVoice(p: Partial<VoiceLocal>): void;
}

const initialLocal: LocalPlayer = {
  status: 'idle',
  drift: null,
  rate: 1,
  detour: false,
  blocked: false,
  muted: false,
  volume: 1,
  seekLead: 0.12,
  time: 0,
  duration: null,
  error: null,
  baseRate: 1,
  ducked: false,
};

const initialVoice: VoiceLocal = { state: 'off', transmitting: false, handsFree: false, error: null, peers: {} };

const comboWindow = new Map<string, { members: Set<string>; first: number; fired: number }>();

export const useRoom = create<State & Actions>((set, get) => ({
  conn: 'idle',
  fatal: null,
  needPasscode: null,
  you: null,
  chaosEnabled: false,
  code: '',
  createdAt: 0,
  settings: null,
  members: {},
  playback: null,
  playlist: [],
  chat: [],
  polls: [],
  votes: [],
  pick: null,
  upNext: null,
  heatmap: {},
  stats: [],
  hovers: {},
  speaking: {},
  voice: initialVoice,
  catchup: null,
  telemetry: {},
  driftHistory: {},
  latency: null,
  clock: { rtt: 0, offset: 0, jitter: 0, synced: false },
  typing: {},
  myPick: {},
  myVotes: {},
  local: initialLocal,
  localFile: null,
  toasts: [],
  floaters: [],
  combos: [],
  ui: { tab: 'chat', discover: false, lab: false, invite: false, settings: false, pick: false, replyTo: null, movieId: null, wrap: null, draw: false },
  unread: 0,

  reset: (code) =>
    set({
      code,
      conn: 'connecting',
      fatal: null,
      needPasscode: null,
      you: null,
      members: {},
      playback: null,
      playlist: [],
      chat: [],
      polls: [],
      votes: [],
      pick: null,
      upNext: null,
      heatmap: {},
      stats: [],
      hovers: {},
      speaking: {},
      voice: initialVoice,
      catchup: null,
      telemetry: {},
      driftHistory: {},
      latency: null,
      local: initialLocal,
    }),

  applySnapshot: (you, s, chaosEnabled) =>
    set({
      you,
      chaosEnabled,
      code: s.code,
      createdAt: s.createdAt,
      settings: s.settings,
      members: Object.fromEntries(s.members.map((m) => [m.id, m])),
      playback: s.playback,
      playlist: s.playlist,
      chat: s.chat,
      polls: s.polls,
      votes: s.votes,
      pick: s.pick,
      upNext: s.upNext,
      heatmap: s.heatmap,
      stats: s.stats ?? [],
      needPasscode: null,
      fatal: null,
    }),

  applyEvent: (ev) => {
    const st = get();
    switch (ev.e) {
      case 'playback':
        if (!st.playback || ev.playback.version >= st.playback.version) set({ playback: ev.playback });
        return;
      case 'member':
        return set({ members: { ...st.members, [ev.member.id]: ev.member } });
      case 'memberLeft': {
        const { [ev.id]: _gone, ...rest } = st.members;
        const { [ev.id]: _h, ...hovers } = st.hovers;
        const { [ev.id]: _s, ...speaking } = st.speaking;
        return set({ members: rest, hovers, speaking });
      }
      case 'chat': {
        if (st.chat.some((c) => c.id === ev.message.id)) return;
        const chat = [...st.chat, ev.message].slice(-300);
        const unread = st.ui.tab === 'chat' || ev.message.kind === 'system' || ev.message.memberId === st.you ? st.unread : st.unread + 1;
        return set({ chat, unread });
      }
      case 'chatUpdate':
        return set({ chat: st.chat.map((c) => (c.id === ev.message.id ? ev.message : c)) });
      case 'playlist':
        return set({ playlist: ev.playlist });
      case 'poll': {
        const exists = st.polls.some((p) => p.id === ev.poll.id);
        return set({ polls: exists ? st.polls.map((p) => (p.id === ev.poll.id ? ev.poll : p)) : [...st.polls, ev.poll] });
      }
      case 'pollRemoved':
        return set({ polls: st.polls.filter((p) => p.id !== ev.id) });
      case 'vote': {
        const exists = st.votes.some((v) => v.id === ev.vote.id);
        return set({ votes: exists ? st.votes.map((v) => (v.id === ev.vote.id ? ev.vote : v)) : [...st.votes, ev.vote] });
      }
      case 'voteRemoved':
        return set({ votes: st.votes.filter((v) => v.id !== ev.id) });
      case 'settings':
        return set({ settings: ev.settings });
      case 'pick': {
        const newSession = ev.pick && ev.pick.id !== st.pick?.id;
        set({ pick: ev.pick, ...(newSession ? { myPick: {}, ui: { ...st.ui, pick: true } } : {}) });
        return;
      }
      case 'upNext':
        return set({ upNext: ev.upNext });
      case 'toast':
        return get().toast(ev.text, ev.tone, ev.icon);
    }
  },

  setTelemetry: (members, latency) => {
    const telemetry: Record<string, MemberTelemetry> = {};
    const hist = { ...get().driftHistory };
    for (const m of members) {
      telemetry[m.id] = m;
      const h = (hist[m.id] ?? []).concat(m.drift ?? NaN).slice(-60);
      hist[m.id] = h;
    }
    set({ telemetry, latency, driftHistory: hist });
  },

  addReactions: (items) => {
    const now = performance.now();
    const floaters = items.map((i) => ({ id: uid(6), emoji: i.emoji, memberId: i.memberId, sway: Math.round((Math.random() - 0.5) * 80) }));
    const combos: Combo[] = [];
    for (const i of items) {
      let w = comboWindow.get(i.emoji);
      if (!w || now - w.first > 2000) w = { members: new Set(), first: now, fired: 0 };
      w.members.add(i.memberId);
      comboWindow.set(i.emoji, w);
      if (w.members.size >= 3 && w.members.size > w.fired) {
        w.fired = w.members.size;
        combos.push({ id: uid(6), emoji: i.emoji, count: w.members.size });
      }
    }
    set((s) => ({ floaters: [...s.floaters, ...floaters].slice(-60), combos: combos.length ? [...s.combos.filter((c) => !combos.some((n) => n.emoji === c.emoji)), ...combos] : s.combos }));
    setTimeout(() => set((s) => ({ floaters: s.floaters.filter((f) => !floaters.includes(f)) })), 2700);
    if (combos.length) setTimeout(() => set((s) => ({ combos: s.combos.filter((c) => !combos.includes(c)) })), 1800);
  },

  toast: (text, tone = 'info', icon) => {
    const id = uid(6);
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, tone, icon }] }));
    setTimeout(() => get().dismissToast(id), tone === 'error' ? 6000 : 4000);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setLocal: (p) => set((s) => ({ local: { ...s.local, ...p } })),
  setUi: (p) =>
    set((s) => ({
      ui: { ...s.ui, ...p },
      unread: p.tab === 'chat' ? 0 : s.unread,
    })),
  setStats: (st) =>
    set((s) => ({
      stats: s.stats.some((x) => x.mediaId === st.mediaId) ? s.stats.map((x) => (x.mediaId === st.mediaId ? st : x)) : [...s.stats, st].slice(-20),
    })),
  setVoice: (p) => set((s) => ({ voice: { ...s.voice, ...p } })),
}));

export const roomState = () => useRoom.getState();

/** Can the current user drive playback directly (vs. votes/forbidden)? */
export function canControl(s: { settings: PublicSettings | null; members: Record<string, Member>; you: string | null }): boolean {
  const me = s.you ? s.members[s.you] : null;
  if (!me || !s.settings) return false;
  return s.settings.controlMode === 'everyone' || me.role !== 'member';
}
