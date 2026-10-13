import { CornerUpLeft, Plus, SendHorizontal, SmilePlus, X } from 'lucide-react';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage } from '@shared/types';
import { fmtTime, parseTimestamp, TIMESTAMP_RE, uid } from '@shared/util';
import { Avatar, useSession } from '../components/ui';
import { cx } from '../lib/util';
import { canControl, useRoom } from '../store';

const QUICK = ['😂', '❤️', '🔥', '😱', '👀', '💀'];

export function Chat() {
  const { client, engine } = useSession();
  const chat = useRoom((s) => s.chat);
  const members = useRoom((s) => s.members);
  const typing = useRoom((s) => s.typing);
  const you = useRoom((s) => s.you);
  const replyTo = useRoom((s) => s.ui.replyTo);
  const setUi = useRoom((s) => s.setUi);
  const hasMedia = useRoom((s) => !!s.playback?.media);
  const [text, setText] = useState('');
  const [showActivity, setShowActivity] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [, force] = useState(0);

  useEffect(() => {
    const t = setInterval(() => force((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const visible = useMemo(() => (showActivity ? chat : chat.filter((c) => c.kind === 'user')), [chat, showActivity]);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [visible.length]);

  const typers = Object.entries(typing)
    .filter(([id, at]) => id !== you && Date.now() - at < 3000 && members[id])
    .map(([id]) => members[id].name);

  const send = () => {
    const t = text.trim();
    if (!t) return;
    client.send({ t: 'chat', id: uid(12), text: t, replyTo: replyTo?.id ?? null, mediaTime: hasMedia ? engine.displayTime() : null });
    setText('');
    setUi({ replyTo: null });
    stick.current = true;
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 pt-2 text-[11px] text-faint">
        <span>{chat.filter((c) => c.kind === 'user').length} messages</span>
        <label className="flex cursor-pointer items-center gap-1.5">
          <input type="checkbox" checked={showActivity} onChange={(e) => setShowActivity(e.target.checked)} className="accent-[var(--color-bulb)]" />
          room activity
        </label>
      </div>
      <div
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
        className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-3 py-2"
        aria-live="polite"
      >
        {visible.length === 0 && (
          <div className="grid h-full place-items-center text-center text-sm text-faint">
            <div>
              Say hi 👋
              <br />
              <span className="text-xs">Timestamps like 12:34 become jump links.</span>
            </div>
          </div>
        )}
        {visible.map((m, i) => (
          <Message key={m.id} m={m} prev={visible[i - 1]} you={you} />
        ))}
      </div>
      <div className="h-5 px-4 text-[11px] text-dim italic">{typers.length > 0 && `${typers.slice(0, 3).join(', ')} ${typers.length === 1 ? 'is' : 'are'} typing…`}</div>
      {replyTo && (
        <div className="mx-3 mb-1 flex items-center gap-2 rounded-lg bg-velvet-2 px-3 py-1.5 text-xs text-dim">
          <CornerUpLeft size={12} /> Replying to <b className="text-paper">{replyTo.name}</b>
          <span className="truncate">{replyTo.text}</span>
          <button className="ml-auto" onClick={() => setUi({ replyTo: null })} aria-label="Cancel reply">
            <X size={13} />
          </button>
        </div>
      )}
      <form
        className="flex items-end gap-2 border-t border-seam p-3"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          rows={1}
          value={text}
          maxLength={500}
          onChange={(e) => {
            setText(e.target.value);
            client.send({ t: 'typing' });
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Message the room…"
          aria-label="Chat message"
          className="max-h-28 min-h-10 flex-1 resize-none rounded-xl border border-seam bg-ink/60 px-3.5 py-2.5 text-sm text-paper outline-none placeholder:text-faint focus:border-bulb/60"
        />
        <button type="submit" className="grid size-10 place-items-center rounded-xl bg-bulb text-ink transition hover:brightness-110 disabled:opacity-40" disabled={!text.trim()} aria-label="Send">
          <SendHorizontal size={17} />
        </button>
      </form>
    </div>
  );
}

function Message({ m, prev, you }: { m: ChatMessage; prev?: ChatMessage; you: string | null }) {
  const { client } = useSession();
  const setUi = useRoom((s) => s.setUi);
  const [picker, setPicker] = useState(false);
  if (m.kind === 'system')
    return <div className="py-1 text-center text-[11px] leading-snug text-faint">{m.text}</div>;
  const grouped = prev && prev.kind === 'user' && prev.memberId === m.memberId && m.ts - prev.ts < 120_000 && !m.replyTo;
  const mine = m.memberId === you;
  return (
    <div className={cx('group relative flex gap-2.5 rounded-xl px-1.5 py-1 hover:bg-white/[0.03]', !grouped && 'mt-2')}>
      <div className="w-8 shrink-0">{!grouped && <Avatar m={m} size={32} />}</div>
      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <span className="text-[13px] font-semibold" style={{ color: m.color }}>
              {m.name}
              {mine && <span className="font-normal text-faint"> (you)</span>}
            </span>
            <span className="font-mono text-[10px] text-faint">
              {new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              {m.mediaTime != null && <> · at {fmtTime(m.mediaTime)}</>}
            </span>
          </div>
        )}
        {m.replyTo && (
          <div className="mb-0.5 truncate border-l-2 border-seam pl-2 text-[11px] text-faint">
            ↪ {m.replyTo.name}: {m.replyTo.text}
          </div>
        )}
        <div className="text-[14px] leading-relaxed break-words text-paper/90">
          <RichText text={m.card ? `${m.text}` : m.text} />
        </div>
        {m.card && <MovieCardInline card={m.card} />}
        {Object.keys(m.reactions).length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {Object.entries(m.reactions).map(([e, who]) => (
              <button
                key={e}
                onClick={() => client.send({ t: 'chatReact', msgId: m.id, emoji: e })}
                className={cx('rounded-full border px-1.5 py-0.5 text-[11px]', you && who.includes(you) ? 'border-bulb/50 bg-bulb/10' : 'border-seam bg-velvet-2')}
              >
                {e} {who.length}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="absolute -top-3 right-1 hidden items-center gap-0.5 rounded-full border border-seam bg-velvet-2 p-0.5 shadow-lg group-hover:flex">
        {picker ? (
          QUICK.map((e) => (
            <button
              key={e}
              className="grid size-7 place-items-center rounded-full hover:bg-white/10"
              onClick={() => {
                client.send({ t: 'chatReact', msgId: m.id, emoji: e });
                setPicker(false);
              }}
            >
              {e}
            </button>
          ))
        ) : (
          <>
            <button className="grid size-7 place-items-center rounded-full text-dim hover:bg-white/10 hover:text-paper" onClick={() => setPicker(true)} aria-label="React">
              <SmilePlus size={14} />
            </button>
            <button className="grid size-7 place-items-center rounded-full text-dim hover:bg-white/10 hover:text-paper" onClick={() => setUi({ replyTo: m })} aria-label="Reply">
              <CornerUpLeft size={14} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Timestamps become seek chips; @mentions of you get highlighted. */
function RichText({ text }: { text: string }) {
  const { engine } = useSession();
  const ctl = useRoom(canControl);
  const me = useRoom((s) => (s.you ? s.members[s.you]?.name : null));
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(TIMESTAMP_RE)) {
    const i = match.index ?? 0;
    parts.push(<Mentions key={`t${last}`} text={text.slice(last, i)} me={me} />);
    const secs = parseTimestamp(match[0]);
    parts.push(
      <button
        key={`ts${i}`}
        onClick={() => secs != null && engine.command('seek', secs)}
        disabled={!ctl}
        className="mx-0.5 rounded bg-beam/15 px-1 font-mono text-[12px] text-beam hover:bg-beam/25 disabled:cursor-default"
        title={ctl ? 'Jump everyone here' : 'Timestamp'}
      >
        {match[0]}
      </button>,
    );
    last = i + match[0].length;
  }
  parts.push(<Mentions key="end" text={text.slice(last)} me={me} />);
  return <>{parts}</>;
}

function Mentions({ text, me }: { text: string; me: string | null | undefined }) {
  const parts = text.split(/(@[\p{L}\p{N}_]+)/u);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('@') ? (
          <span key={i} className={cx('rounded px-0.5 font-semibold', me && p.slice(1).toLowerCase() === me.split(' ')[0].toLowerCase() ? 'bg-bulb/25 text-bulb' : 'text-bulb/90')}>
            {p}
          </span>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}

function MovieCardInline({ card }: { card: NonNullable<ChatMessage['card']> }) {
  const { client } = useSession();
  const setUi = useRoom((s) => s.setUi);
  return (
    <div className="mt-1.5 flex max-w-xs items-center gap-3 rounded-xl border border-seam bg-velvet-2 p-2">
      {card.poster ? <img src={card.poster} alt="" className="h-16 w-11 rounded-md object-cover" /> : <div className="h-16 w-11 rounded-md bg-velvet-3" />}
      <div className="min-w-0 flex-1">
        <button className="truncate text-left font-serif text-[15px] hover:text-bulb" onClick={() => setUi({ discover: true, movieId: card.movieId })}>
          {card.title}
        </button>
        <div className="font-mono text-[10px] text-faint">{card.year}</div>
        <button className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-bulb" onClick={() => client.send({ t: 'pl', op: 'addMovie', movieId: card.movieId })}>
          <Plus size={12} /> Add to queue
        </button>
      </div>
    </div>
  );
}
