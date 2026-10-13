import { ArrowRight, FlaskConical, Link2, LogOut, Settings2, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { prettyCode, REACTIONS } from '@shared/util';
import { IdentityPicker } from '../components/IdentityPicker';
import { Avatar, btn, input, SessionCtx, Toasts, useSession, type Session } from '../components/ui';
import { cx, loadIdentity, navigate, saveIdentity, tokenStore, type Identity } from '../lib/util';
import { RoomClient } from '../net/client';
import { ActionBar } from '../room/ActionBar';
import { Discover } from '../room/Discover';
import { GroupPick } from '../room/GroupPick';
import { InviteModal } from '../room/Invite';
import { Player } from '../room/Player';
import { SettingsModal } from '../room/Settings';
import { Sidebar } from '../room/Sidebar';
import { SyncLab } from '../room/SyncLab';
import { TheaterRow } from '../room/TheaterRow';
import { useRoom } from '../store';
import { SyncEngine } from '../sync/engine';
import { VoiceManager } from '../voice/voice';
import { Wrap } from '../room/Wrap';
import { Wordmark } from './Lobby';

interface RoomPreview {
  exists: boolean;
  name: string;
  online: number;
  hasPasscode: boolean;
  nowPlaying: string | null;
  members: { name: string; avatar: string; color: string }[];
}

export function RoomPage({ code }: { code: string }) {
  const [identity, setIdentity] = useState<Identity>(loadIdentity);
  const autojoin = typeof sessionStorage !== 'undefined' && sessionStorage.getItem(`marquee:autojoin:${code}`) === '1';
  // Returning to a seat (refresh) skips the gate; autoplay falls back to muted + 'tap to unmute'.
  const [joined, setJoined] = useState((autojoin || !!tokenStore.get(code)) && !!identity.name.trim());
  const [passcode, setPasscode] = useState<string | undefined>(() => sessionStorage.getItem(`marquee:pass:${code}`) ?? undefined);

  useEffect(() => {
    sessionStorage.removeItem(`marquee:autojoin:${code}`);
  }, [code]);

  if (!joined)
    return (
      <Gate
        code={code}
        identity={identity}
        setIdentity={setIdentity}
        onJoin={(pc) => {
          saveIdentity(identity);
          if (pc) setPasscode(pc);
          setJoined(true);
        }}
      />
    );
  return <RoomShell code={code} identity={identity} passcode={passcode} setPasscode={setPasscode} />;
}

// ─── Entry gate: identity + the user gesture that unlocks audio autoplay ────
function Gate({ code, identity, setIdentity, onJoin }: { code: string; identity: Identity; setIdentity: (i: Identity) => void; onJoin: (passcode?: string) => void }) {
  const [preview, setPreview] = useState<RoomPreview | null | 'missing'>(null);
  const [pc, setPc] = useState('');
  useEffect(() => {
    fetch(`/api/rooms/${code}`)
      .then((r) => (r.ok ? r.json() : 'missing'))
      .then(setPreview)
      .catch(() => setPreview('missing'));
  }, [code]);

  if (preview === 'missing')
    return (
      <Centered>
        <div className="font-marquee text-5xl tracking-wider text-bulb">HOUSE LIGHTS ARE UP</div>
        <p className="mt-3 max-w-sm text-dim">Room {prettyCode(code)} doesn’t exist or has closed. Ask your host for a fresh link, or start your own.</p>
        <button className={cx(btn.primary, 'mt-6')} onClick={() => navigate('/')}>
          Go to the lobby
        </button>
      </Centered>
    );

  const ready = identity.name.trim().length > 0 && (!preview?.hasPasscode || pc.length > 0);
  return (
    <div className="auditorium grid min-h-full place-items-center p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 flex justify-center">
          <Wordmark />
        </div>
        <div className="rounded-3xl border border-seam bg-velvet/85 p-6 shadow-2xl backdrop-blur">
          <div className="font-mono text-[11px] tracking-[0.2em] text-faint uppercase">You’re invited to</div>
          <div className="mt-1 font-serif text-3xl leading-tight">{preview?.name ?? <span className="skeleton inline-block h-8 w-48 rounded" />}</div>
          <div className="mt-3 flex items-center gap-3 text-sm text-dim">
            <span className="flex -space-x-2">
              {(preview?.members ?? []).slice(0, 6).map((m, i) => (
                <Avatar key={i} m={m} size={28} className="ring-2 ring-velvet" />
              ))}
            </span>
            {preview && (
              <span>
                {preview.online ? `${preview.online} watching` : 'Nobody here yet — you’re first'}
                {preview.nowPlaying && <> · now showing <em className="text-paper">{preview.nowPlaying}</em></>}
              </span>
            )}
          </div>
          <div className="my-6 h-px bg-seam" />
          <IdentityPicker value={identity} onChange={setIdentity} autoFocus={!identity.name} />
          {preview && preview.hasPasscode && (
            <div className="mt-4">
              <input className={input} type="password" placeholder="Room passcode" value={pc} onChange={(e) => setPc(e.target.value)} />
            </div>
          )}
          <button className={cx(btn.primary, 'mt-6 w-full py-3')} disabled={!ready} onClick={() => onJoin(pc || undefined)}>
            Take your seat <ArrowRight size={16} />
          </button>
        </div>
        <div className="mt-4 text-center font-mono text-[11px] text-faint">ROOM {prettyCode(code)}</div>
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="auditorium grid min-h-full place-items-center p-6 text-center"><div className="flex flex-col items-center">{children}</div></div>;
}

// ─── The room ────────────────────────────────────────────────────────────────
function RoomShell({ code, identity, passcode, setPasscode }: { code: string; identity: Identity; passcode?: string; setPasscode: (p: string) => void }) {
  const [session, setSession] = useState<Session | null>(null);
  const fatal = useRoom((s) => s.fatal);
  const needPasscode = useRoom((s) => s.needPasscode);

  useEffect(() => {
    useRoom.getState().reset(code);
    const client = new RoomClient(code, identity, passcode);
    const engine = new SyncEngine(client);
    const voice = new VoiceManager(client, engine);
    client.connect();
    setSession({ client, engine, voice });
    return () => {
      voice.destroy();
      client.close();
      engine.destroy();
    };
    // identity changes are pushed via `profile` messages, not reconnects
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, passcode]);

  if (fatal)
    return (
      <Centered>
        <div className="font-marquee text-5xl tracking-wider text-bulb">{fatal.code === 'kicked' ? 'SHOW’S OVER FOR YOU' : 'CAN’T OPEN THIS ROOM'}</div>
        <p className="mt-3 max-w-sm text-dim">{fatal.message}</p>
        <button className={cx(btn.primary, 'mt-6')} onClick={() => (fatal.code === 'version' ? location.reload() : navigate('/'))}>
          {fatal.code === 'version' ? 'Refresh' : 'Back to the lobby'}
        </button>
      </Centered>
    );
  if (needPasscode)
    return (
      <Centered>
        <PasscodePrompt message={needPasscode} onSubmit={(p) => setPasscode(p)} />
      </Centered>
    );
  if (!session) return null;
  return (
    <SessionCtx.Provider value={session}>
      <RoomLayout />
    </SessionCtx.Provider>
  );
}

function PasscodePrompt({ message, onSubmit }: { message: string; onSubmit: (p: string) => void }) {
  const [p, setP] = useState('');
  return (
    <form className="w-full max-w-sm" onSubmit={(e) => (e.preventDefault(), p && onSubmit(p))}>
      <div className="font-marquee text-4xl tracking-wider text-bulb">MEMBERS ONLY</div>
      <p className="mt-2 text-dim">{message}</p>
      <input className={cx(input, 'mt-5')} type="password" autoFocus placeholder="Passcode" value={p} onChange={(e) => setP(e.target.value)} />
      <button className={cx(btn.primary, 'mt-4 w-full')}>Enter</button>
    </form>
  );
}

function RoomLayout() {
  const { client, engine, voice } = useSession();
  const ui = useRoom((s) => s.ui);
  const setUi = useRoom((s) => s.setUi);
  const settings = useRoom((s) => s.settings);
  const code = useRoom((s) => s.code);
  const you = useRoom((s) => (s.you ? s.members[s.you] : null));
  const onlineCount = useRoom((s) => Object.values(s.members).filter((m) => m.online).length);

  // Room-wide keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
      const st = useRoom.getState();
      if (st.ui.discover || st.ui.pick || st.ui.invite || st.ui.settings) return;
      if (e.key === ' ' || e.key === 'k') {
        e.preventDefault();
        engine.togglePlay();
      } else if (e.key === 'ArrowLeft' || e.key === 'j') engine.command('seek', Math.max(0, engine.displayTime() - 10));
      else if (e.key === 'ArrowRight' || e.key === 'l') engine.command('seek', engine.displayTime() + 10);
      else if (/^[0-9]$/.test(e.key)) {
        const emoji = REACTIONS[(Number(e.key) + 9) % 10];
        client.send({ t: 'react', emoji, mediaTime: st.playback?.media ? engine.displayTime() : null });
      } else if (['d', 'g', 's', 'i'].includes(e.key)) {
        e.preventDefault(); // don't let the shortcut letter land in the input that opens
        if (e.key === 'd') setUi({ discover: true });
        else if (e.key === 'g') setUi({ pick: true });
        else if (e.key === 's') setUi({ lab: !st.ui.lab });
        else setUi({ invite: true });
      } else if (e.key === 'v' && !e.repeat && st.voice.state === 'talk' && !st.voice.handsFree) {
        voice.setTransmit(true); // push-to-talk: hold V
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const st = useRoom.getState();
      if (e.key === 'v' && st.voice.state === 'talk' && !st.voice.handsFree) voice.setTransmit(false);
    };
    const onBlur = () => !useRoom.getState().voice.handsFree && voice.setTransmit(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [client, engine, voice, setUi]);

  return (
    <div className="auditorium flex h-dvh flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-2 px-3 py-3 sm:gap-3 sm:px-4">
        <Wordmark small />
        <div className="ml-2 hidden min-w-0 items-baseline gap-3 sm:flex">
          <h1 className="truncate font-serif text-xl">{settings?.name ?? '…'}</h1>
          <button
            onClick={() => setUi({ invite: true })}
            className="group inline-flex items-center gap-1.5 rounded-md bg-velvet-2 px-2 py-1 font-marquee text-lg leading-none tracking-[0.18em] text-bulb ring-1 ring-seam transition hover:ring-bulb/60"
            title="Invite friends"
          >
            {code ? prettyCode(code) : ''}
          </button>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <ConnectionPill />
          <button className={cx(btn.ghost, 'max-sm:hidden')} onClick={() => setUi({ invite: true })}>
            <Link2 size={15} /> Invite
          </button>
          <button
            className={cx(btn.icon, ui.lab && 'bg-beam/15 text-beam')}
            onClick={() => setUi({ lab: !ui.lab })}
            aria-label="Sync Lab"
            title="Sync Lab — live sync telemetry (S)"
          >
            <FlaskConical size={18} />
          </button>
          {you && you.role !== 'member' && (
            <button className={btn.icon} onClick={() => setUi({ settings: true })} aria-label="Room settings" title="Room settings">
              <Settings2 size={18} />
            </button>
          )}
          <button className={cx(btn.icon, 'relative')} onClick={() => setUi({ tab: 'people' })} aria-label="People" title="People">
            <Users size={18} />
            <span className="absolute -top-0.5 -right-0.5 grid min-w-4 place-items-center rounded-full bg-bulb px-1 font-mono text-[9px] font-bold text-ink">{onlineCount}</span>
          </button>
          <button
            className={btn.icon}
            onClick={() => {
              client.leave();
              navigate('/');
            }}
            aria-label="Leave room"
            title="Leave room"
          >
            <LogOut size={17} />
          </button>
        </div>
      </header>
      <ReconnectBanner />

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto px-3 pb-3 sm:px-4 lg:grid-cols-[minmax(0,1fr)_380px] lg:overflow-hidden">
        <div className="flex min-w-0 flex-col gap-3 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
          <Player />
          <ActionBar />
          <TheaterRow />
        </div>
        <Sidebar />
      </div>

      <Discover />
      <GroupPick />
      <SyncLab />
      <InviteModal />
      <SettingsModal />
      <Wrap />
      <Toasts />
    </div>
  );
}

function ConnectionPill() {
  const conn = useRoom((s) => s.conn);
  const rtt = useRoom((s) => s.clock.rtt);
  const tone = conn !== 'connected' ? 'bg-bulb' : rtt > 250 ? 'bg-alarm' : rtt > 100 ? 'bg-bulb' : 'bg-ok';
  return (
    <span className="mr-1 hidden items-center gap-2 rounded-full border border-seam bg-velvet-2/70 px-3 py-1.5 font-mono text-[11px] text-dim md:inline-flex" title="Round-trip time to the server">
      <span className={cx('size-2 rounded-full', tone, conn !== 'connected' && 'animate-pulse')} />
      {conn === 'connected' ? `${Math.round(rtt)} ms` : conn === 'reconnecting' ? 'reconnecting' : 'connecting'}
    </span>
  );
}

function ReconnectBanner() {
  const conn = useRoom((s) => s.conn);
  if (conn !== 'reconnecting') return null;
  return (
    <div className="mx-4 mb-2 flex items-center gap-3 rounded-xl border border-bulb/30 bg-bulb/10 px-4 py-2 text-sm text-bulb" role="status">
      <span className="size-2 animate-ping rounded-full bg-bulb" />
      Connection lost — reconnecting. Your seat and messages are saved; playback keeps going locally.
    </div>
  );
}

