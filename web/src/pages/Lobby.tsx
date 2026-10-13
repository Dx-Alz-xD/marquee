import { ArrowRight, Globe, Sparkles, Wifi } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { normalizeRoomCode, ROOM_ALPHABET } from '@shared/util';
import { IdentityPicker } from '../components/IdentityPicker';
import { btn, input, SectionLabel } from '../components/ui';
import { api, cx, loadIdentity, navigate, saveIdentity, type ServerInfo } from '../lib/util';

type Mode = 'host' | 'everyone' | 'democracy';

export function Lobby({ invalidCode }: { invalidCode: string | null }) {
  const [identity, setIdentity] = useState(loadIdentity);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(invalidCode ? `“${invalidCode}” isn't a valid room code` : null);
  const [checking, setChecking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [roomName, setRoomName] = useState('');
  const [controlMode, setControlMode] = useState<Mode>('everyone');
  const [strict, setStrict] = useState(true);
  const [passcode, setPasscode] = useState('');
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<ServerInfo>('/api/info').then(setInfo).catch(() => {});
  }, []);
  useEffect(() => saveIdentity(identity), [identity]);

  const nameOk = identity.name.trim().length > 0;

  async function join() {
    const c = normalizeRoomCode(code);
    if (!c) return setError('Room codes are 6 characters, like K7M-Q2X');
    setChecking(true);
    setError(null);
    try {
      const r = await fetch(`/api/rooms/${c}`);
      if (!r.ok) throw new Error('No room with that code — double-check it with your host');
      navigate(`/r/${c}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  }

  async function create() {
    if (!nameOk) return setError('Pick a name first — it’s how friends see you');
    setCreating(true);
    try {
      const { code: c } = await api<{ code: string }>('/api/rooms', {
        method: 'POST',
        body: JSON.stringify({ name: roomName || `${identity.name.trim()}'s room`, controlMode, syncPolicy: strict ? 'strict' : 'relaxed', passcode: passcode || undefined }),
      });
      if (passcode) sessionStorage.setItem(`marquee:pass:${c}`, passcode);
      sessionStorage.setItem(`marquee:autojoin:${c}`, '1');
      navigate(`/r/${c}`);
    } catch (e) {
      setError((e as Error).message);
      setCreating(false);
    }
  }

  const tiles = Array.from({ length: 6 }, (_, i) => code[i] ?? '');

  return (
    <div className="auditorium min-h-full overflow-x-hidden">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5">
        <Wordmark />
        {info && (
          <div className="hidden items-center gap-4 font-mono text-[11px] text-dim sm:flex">
            <span>{info.catalog.total.toLocaleString()} films in the catalog</span>
            {info.lanUrls[0] && (
              <span className="inline-flex items-center gap-1.5">
                <Wifi size={12} className="text-beam" /> {info.lanUrls[0].replace('http://', '')}
              </span>
            )}
            {info.publicUrl && (
              <span className="inline-flex items-center gap-1.5">
                <Globe size={12} className="text-beam" /> public link on
              </span>
            )}
          </div>
        )}
      </header>

      <main className="mx-auto flex max-w-6xl flex-col items-center px-5 pt-6 pb-20 sm:pt-12">
        <motion.h1
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center font-serif text-[clamp(2.4rem,6vw,4.6rem)] leading-[0.95] font-light tracking-tight"
        >
          Movie night, <em className="font-normal text-bulb">wherever</em>
          <br /> your friends are.
        </motion.h1>
        <p className="mt-5 max-w-xl text-center text-[15px] leading-relaxed text-dim">
          One room, one remote, every screen on the same frame. Pick a film together, react together, and never shout
          “wait, pause it” again.
        </p>

        {/* ── The marquee sign: the join box ── */}
        <motion.div
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.1 }}
          className="marquee-frame mt-10 w-full max-w-3xl px-6 py-9 sm:px-12 sm:py-12"
          onClick={() => codeRef.current?.focus()}
        >
          <div className="text-center font-marquee text-base tracking-[0.3em] text-bulb/90 drop-shadow-[0_0_8px_var(--color-bulb)] sm:text-lg sm:tracking-[0.5em]">NOW SHOWING IN ROOM</div>
          <div className="relative mt-5 flex items-center justify-center gap-2 sm:gap-3">
            {tiles.map((ch, i) => (
              <span key={i} className="contents">
                {i === 3 && <span className="font-marquee text-4xl text-bulb/60">–</span>}
                <span
                  className={cx(
                    'grid h-16 w-11 place-items-center text-5xl sm:h-24 sm:w-[4.2rem] sm:text-7xl',
                    ch ? 'tile' : 'tile-empty rounded-md',
                    !ch && i === code.length && 'ring-2 ring-bulb/50',
                  )}
                >
                  {ch}
                </span>
              </span>
            ))}
            <input
              ref={codeRef}
              aria-label="Room code"
              value={code}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                const c = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').split('').filter((ch) => ROOM_ALPHABET.includes(ch)).join('').slice(0, 6);
                setCode(c);
                setError(null);
              }}
              onPaste={(e) => {
                const n = normalizeRoomCode(e.clipboardData.getData('text'));
                if (n) {
                  e.preventDefault();
                  setCode(n);
                }
              }}
              onKeyDown={(e) => e.key === 'Enter' && join()}
              className="absolute inset-0 cursor-text opacity-0"
            />
          </div>
          <div className="mt-7 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
            <button className={btn.primary} disabled={code.length !== 6 || checking} onClick={(e) => (e.stopPropagation(), join())}>
              {checking ? 'Finding your room…' : 'Take your seat'} <ArrowRight size={16} />
            </button>
            <span className="text-xs text-dim">Type the code your host shared, or open their invite link.</span>
          </div>
          {error && <div className="mt-4 text-center text-sm text-alarm" role="alert">{error}</div>}
        </motion.div>

        <div className="mt-8 flex items-center gap-4 text-faint">
          <span className="h-px w-16 bg-seam" />
          <span className="font-mono text-[11px] tracking-[0.25em] uppercase">or host</span>
          <span className="h-px w-16 bg-seam" />
        </div>

        <section className="mt-8 grid w-full max-w-3xl gap-5 md:grid-cols-[1.05fr_1fr]">
          <div className="rounded-3xl border border-seam bg-velvet/80 p-6 backdrop-blur">
            <IdentityPicker value={identity} onChange={setIdentity} />
          </div>
          <div className="flex flex-col rounded-3xl border border-seam bg-velvet/80 p-6 backdrop-blur">
            <div className="font-serif text-2xl">Start a room</div>
            <p className="mt-1 text-sm text-dim">You’ll get a code and a link to send around. Everyone on your Wi-Fi can join instantly.</p>
            {!showCreate ? (
              <button className={cx(btn.primary, 'mt-auto self-start')} onClick={() => setShowCreate(true)}>
                <Sparkles size={16} /> Set up a room
              </button>
            ) : (
              <div className="mt-4 flex flex-col gap-4">
                <div>
                  <SectionLabel className="mb-1.5">Room name</SectionLabel>
                  <input className={input} value={roomName} maxLength={60} placeholder={`${identity.name.trim() || 'Your'}'s room`} onChange={(e) => setRoomName(e.target.value)} />
                </div>
                <div>
                  <SectionLabel className="mb-1.5">Who holds the remote</SectionLabel>
                  <div className="grid grid-cols-3 gap-1 rounded-xl bg-ink/60 p-1">
                    {(
                      [
                        ['everyone', 'Everyone'],
                        ['host', 'Just me'],
                        ['democracy', 'Majority vote'],
                      ] as const
                    ).map(([v, l]) => (
                      <button
                        key={v}
                        onClick={() => setControlMode(v)}
                        className={cx('rounded-lg py-2 text-xs font-semibold transition', controlMode === v ? 'bg-velvet-3 text-bulb' : 'text-dim hover:text-paper')}
                      >
                        {l}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="flex cursor-pointer items-start gap-3 text-sm">
                  <input type="checkbox" checked={strict} onChange={(e) => setStrict(e.target.checked)} className="mt-0.5 size-4 accent-[var(--color-bulb)]" />
                  <span>
                    Wait for anyone who’s buffering
                    <span className="block text-xs text-dim">Pauses everyone for up to 10 s so no one misses a scene.</span>
                  </span>
                </label>
                <div>
                  <SectionLabel className="mb-1.5">Passcode (optional)</SectionLabel>
                  <input className={input} value={passcode} maxLength={64} placeholder="Leave empty for an open room" onChange={(e) => setPasscode(e.target.value)} />
                </div>
                <button className={btn.primary} disabled={creating || !nameOk} onClick={create}>
                  {creating ? 'Opening the doors…' : 'Open the room'} <ArrowRight size={16} />
                </button>
                {!nameOk && <p className="-mt-2 text-xs text-dim">Add your name on the left first.</p>}
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

export function Wordmark({ small }: { small?: boolean }) {
  return (
    <a href="/" onClick={(e) => (e.preventDefault(), navigate('/'))} className="group inline-flex items-center gap-2" aria-label="Marquee home">
      <span className="flex gap-[3px]">
        {[0, 1, 2].map((i) => (
          <span key={i} className="size-1.5 rounded-full bg-bulb shadow-[0_0_6px_var(--color-bulb)]" style={{ opacity: 1 - i * 0.25 }} />
        ))}
      </span>
      <span className={cx('font-marquee leading-none tracking-[0.12em] text-paper', small ? 'text-xl' : 'text-2xl')}>MARQUEE</span>
    </a>
  );
}
