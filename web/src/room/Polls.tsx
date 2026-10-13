import { Check, ListVideo, Plus, Timer, Trophy, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Poll } from '@shared/types';
import { btn, input, SectionLabel, useSession } from '../components/ui';
import { cx } from '../lib/util';
import { canControl, useRoom } from '../store';

export function Polls() {
  const polls = useRoom((s) => s.polls);
  const [creating, setCreating] = useState(false);
  const open = polls.filter((p) => !p.closed);
  const closed = polls.filter((p) => p.closed).reverse();
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {creating ? (
          <CreatePoll onDone={() => setCreating(false)} />
        ) : (
          <button className={cx(btn.primary, 'w-full')} onClick={() => setCreating(true)}>
            <Plus size={16} /> New poll
          </button>
        )}
        {polls.length === 0 && !creating && (
          <p className="px-2 pt-4 text-center text-sm text-faint">Ask the room anything — “What next?”, “Snack break?”. Polls can queue or play the winner automatically.</p>
        )}
        {open.map((p) => (
          <PollCard key={p.id} poll={p} />
        ))}
        {closed.length > 0 && <SectionLabel className="px-1 pt-2">Closed</SectionLabel>}
        {closed.map((p) => (
          <PollCard key={p.id} poll={p} />
        ))}
      </div>
    </div>
  );
}

function PollCard({ poll }: { poll: Poll }) {
  const { client } = useSession();
  const you = useRoom((s) => s.you);
  const mine = useRoom((s) => s.myVotes[poll.id]);
  const members = useRoom((s) => s.members);
  const ctl = useRoom(canControl);
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!poll.endsAt || poll.closed) return setLeft(null);
    const t = setInterval(() => setLeft(Math.max(0, Math.ceil((poll.endsAt! - Date.now()) / 1000))), 250);
    return () => clearInterval(t);
  }, [poll.endsAt, poll.closed]);

  const total = Math.max(1, Object.values(poll.tally).reduce((a, b) => a + b, 0));
  const myChoice = mine ?? (poll.voters && you ? Object.entries(poll.voters).filter(([, ids]) => ids.includes(you)).map(([o]) => o) : []);

  const vote = (optionId: string) => {
    if (poll.closed) return;
    let next: string[];
    if (poll.multi) next = myChoice.includes(optionId) ? myChoice.filter((x) => x !== optionId) : [...myChoice, optionId];
    else next = myChoice.includes(optionId) ? [] : [optionId];
    useRoom.setState((s) => ({ myVotes: { ...s.myVotes, [poll.id]: next } }));
    client.send({ t: 'poll', op: 'vote', pollId: poll.id, optionIds: next });
  };

  return (
    <div className={cx('rounded-2xl border p-3.5', poll.closed ? 'border-seam bg-ink/30' : 'border-seam bg-velvet-2/70')}>
      <div className="flex items-start gap-2">
        <div className="flex-1">
          <div className="font-serif text-[17px] leading-snug">{poll.question}</div>
          <div className="mt-0.5 font-mono text-[10px] text-faint">
            {poll.createdByName} · {poll.totalVoters} voted{poll.multi ? ' · pick any' : ''}
            {poll.anonymous ? ' · anonymous' : ''}
            {poll.action !== 'none' && ` · winner gets ${poll.action === 'play' ? 'played' : 'queued'}`}
          </div>
        </div>
        {left != null && (
          <span className="inline-flex items-center gap-1 rounded-full bg-bulb/15 px-2 py-0.5 font-mono text-[11px] text-bulb">
            <Timer size={11} /> {left}s
          </span>
        )}
      </div>
      <div className="mt-3 space-y-1.5">
        {poll.options.map((o) => {
          const n = poll.tally[o.id] ?? 0;
          const pct = (n / total) * 100;
          const chosen = myChoice.includes(o.id);
          const won = poll.closed && poll.winner === o.id;
          return (
            <button
              key={o.id}
              onClick={() => vote(o.id)}
              disabled={poll.closed}
              className={cx('relative block w-full overflow-hidden rounded-xl border px-3 py-2 text-left text-sm transition', chosen ? 'border-bulb/60' : 'border-seam hover:border-faint', poll.closed && 'cursor-default')}
            >
              <span className={cx('absolute inset-y-0 left-0 transition-all duration-500', won ? 'bg-bulb/30' : chosen ? 'bg-bulb/15' : 'bg-white/5')} style={{ width: `${pct}%` }} />
              <span className="relative flex items-center gap-2">
                {won ? <Trophy size={14} className="text-bulb" /> : chosen ? <Check size={14} className="text-bulb" /> : <span className="size-3.5 rounded-full border border-faint" />}
                <span className="flex-1 truncate">{o.label}</span>
                {o.media && <ListVideo size={12} className="text-faint" />}
                <span className="font-mono text-xs text-dim">{n}</span>
              </span>
              {poll.voters && poll.voters[o.id]?.length > 0 && (
                <span className="relative mt-1 block truncate pl-5 text-[10px] text-faint">{poll.voters[o.id].map((id) => members[id]?.name ?? '…').join(', ')}</span>
              )}
            </button>
          );
        })}
      </div>
      {!poll.closed && (poll.createdBy === you || ctl) && (
        <button className="mt-2.5 text-xs font-semibold text-dim hover:text-paper" onClick={() => client.send({ t: 'poll', op: 'close', pollId: poll.id })}>
          Close poll now
        </button>
      )}
    </div>
  );
}

function CreatePoll({ onDone }: { onDone: () => void }) {
  const { client } = useSession();
  const playlist = useRoom((s) => s.playlist);
  const [question, setQuestion] = useState('What should we watch next?');
  const [options, setOptions] = useState<{ label: string; itemId?: string; movieId?: string | null }[]>([{ label: '' }, { label: '' }]);
  const [multi, setMulti] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const [duration, setDuration] = useState(60);
  const [action, setAction] = useState<'none' | 'queue' | 'play'>('none');

  const fromQueue = () => {
    const items = playlist.slice(0, 6).map((i) => ({ label: i.media.title, itemId: i.id, movieId: i.media.movieId ?? null }));
    if (items.length >= 2) {
      setOptions(items);
      setAction('play');
    }
  };
  const valid = question.trim() && options.filter((o) => o.label.trim()).length >= 2;

  return (
    <div className="rounded-2xl border border-bulb/40 bg-velvet-2 p-3.5">
      <div className="flex items-center justify-between">
        <SectionLabel>New poll</SectionLabel>
        <button className={cx(btn.icon, 'size-7')} onClick={onDone} aria-label="Cancel">
          <X size={14} />
        </button>
      </div>
      <input className={cx(input, 'mt-2')} value={question} maxLength={200} onChange={(e) => setQuestion(e.target.value)} aria-label="Question" />
      <div className="mt-2 space-y-1.5">
        {options.map((o, i) => (
          <div key={i} className="flex gap-1.5">
            <input
              className={input}
              placeholder={`Option ${i + 1}`}
              value={o.label}
              maxLength={120}
              onChange={(e) => setOptions(options.map((x, j) => (j === i ? { label: e.target.value } : x)))}
            />
            {options.length > 2 && (
              <button className={btn.icon} onClick={() => setOptions(options.filter((_, j) => j !== i))} aria-label="Remove option">
                <X size={14} />
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {options.length < 8 && (
          <button className={btn.chip} onClick={() => setOptions([...options, { label: '' }])}>
            <Plus size={12} /> Option
          </button>
        )}
        {playlist.length >= 2 && (
          <button className={btn.chip} onClick={fromQueue}>
            <ListVideo size={12} /> Use the queue
          </button>
        )}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} className="accent-[var(--color-bulb)]" /> Multiple choice
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} className="accent-[var(--color-bulb)]" /> Anonymous
        </label>
        <label className="flex items-center gap-2">
          Ends after
          <select value={duration} onChange={(e) => setDuration(Number(e.target.value))} className="rounded-lg border border-seam bg-ink px-1.5 py-1">
            <option value={30}>30 s</option>
            <option value={60}>1 min</option>
            <option value={180}>3 min</option>
            <option value={0}>manual</option>
          </select>
        </label>
        <label className="flex items-center gap-2">
          Winner
          <select value={action} onChange={(e) => setAction(e.target.value as typeof action)} className="rounded-lg border border-seam bg-ink px-1.5 py-1">
            <option value="none">just a vote</option>
            <option value="queue">gets queued</option>
            <option value="play">plays now</option>
          </select>
        </label>
      </div>
      <button
        className={cx(btn.primary, 'mt-3 w-full')}
        disabled={!valid}
        onClick={() => {
          client.send({
            t: 'poll',
            op: 'create',
            question: question.trim(),
            options: options.filter((o) => o.label.trim()).map((o) => ({ label: o.label.trim(), itemId: o.itemId ?? null, movieId: o.movieId ?? null })),
            multi,
            anonymous,
            durationSec: duration,
            action,
          });
          onDone();
        }}
      >
        Ask the room
      </button>
    </div>
  );
}
