import { Clapperboard, Headphones, Lock, Mic, MicOff, PhoneOff, Search, Wand2 } from 'lucide-react';
import { REACTIONS } from '@shared/util';
import { btn, useSession } from '../components/ui';
import { cx } from '../lib/util';
import { useRoom } from '../store';

export function ActionBar() {
  const { client, engine } = useSession();
  const setUi = useRoom((s) => s.setUi);
  const hasMedia = useRoom((s) => !!s.playback?.media);
  const mediaId = useRoom((s) => s.playback?.media?.id ?? null);
  const hasStats = useRoom((s) => !!mediaId && s.stats.some((x) => x.mediaId === mediaId));
  const pickActive = useRoom((s) => s.pick?.status === 'active');

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="no-scrollbar flex min-w-0 flex-1 basis-full items-center gap-1 overflow-x-auto rounded-full border border-seam bg-velvet/80 p-1 sm:basis-auto" role="group" aria-label="Send a reaction">
        {REACTIONS.map((e, i) => (
          <button
            key={e}
            className="grid size-9 shrink-0 place-items-center rounded-full text-xl transition hover:-translate-y-0.5 hover:scale-125 hover:bg-white/5 active:scale-95"
            title={`React ${e} (${(i + 1) % 10})`}
            onClick={() => client.send({ t: 'react', emoji: e, mediaTime: hasMedia ? engine.displayTime() : null })}
          >
            {e}
          </button>
        ))}
      </div>
      <VoiceControl />
      <button className={btn.ghost} onClick={() => setUi({ discover: true })} title="Browse movies (D)">
        <Search size={15} /> Discover
      </button>
      <button className={pickActive ? btn.primary : btn.ghost} onClick={() => setUi({ pick: true })} title="Group Pick (G)">
        <Wand2 size={15} /> {pickActive ? 'Group Pick live!' : 'Group Pick'}
      </button>
      {hasStats && (
        <button className={cx(btn.icon, 'border border-seam')} onClick={() => setUi({ wrap: mediaId })} title="Tonight’s wrap: top moments, awards & ratings" aria-label="Open the wrap">
          <Clapperboard size={16} />
        </button>
      )}
    </div>
  );
}

/** Join voice → hold-to-talk button (or V), hands-free latch, leave. */
function VoiceControl() {
  const { voice } = useSession();
  const v = useRoom((s) => s.voice);
  const inVoice = useRoom((s) => Object.values(s.members).filter((m) => m.online && m.voice !== 'off').length);
  const talking = useRoom((s) => (s.you ? !!s.speaking[s.you] : false));

  if (v.state === 'off' || v.state === 'connecting')
    return (
      <button className={btn.ghost} disabled={v.state === 'connecting'} onClick={() => void voice.join()} title="Talk to the room — the movie quietly dips while someone speaks">
        <Headphones size={15} /> {v.state === 'connecting' ? 'Joining…' : inVoice ? `Join voice · ${inVoice}` : 'Join voice'}
      </button>
    );

  const connected = Object.values(v.peers).filter((p) => p === 'connected').length;
  return (
    <div className="flex items-center gap-1 rounded-full border border-seam bg-velvet/80 p-1" title={v.error ?? undefined}>
      {v.state === 'talk' ? (
        <>
          <button
            className={cx(
              'inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-xs font-semibold transition select-none',
              v.transmitting ? 'bg-bulb text-ink shadow-[0_0_20px_-4px_var(--color-bulb)]' : 'bg-white/5 text-paper hover:bg-white/10',
              talking && 'scale-105',
            )}
            onPointerDown={(e) => {
              if (v.handsFree) return;
              (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
              voice.setTransmit(true);
            }}
            onPointerUp={() => !v.handsFree && voice.setTransmit(false)}
            onPointerCancel={() => !v.handsFree && voice.setTransmit(false)}
            onContextMenu={(e) => e.preventDefault()}
            aria-pressed={v.transmitting}
            aria-label="Hold to talk"
          >
            {v.transmitting ? <Mic size={14} /> : <MicOff size={14} />}
            {v.handsFree ? (v.transmitting ? 'Mic open' : 'Mic off') : v.transmitting ? 'Talking…' : 'Hold to talk (V)'}
          </button>
          <button
            className={cx('grid size-9 place-items-center rounded-full transition', v.handsFree ? 'bg-bulb/20 text-bulb' : 'text-dim hover:bg-white/10 hover:text-paper')}
            onClick={() => voice.setHandsFree(!v.handsFree)}
            aria-pressed={v.handsFree}
            title={v.handsFree ? 'Hands-free on (mic stays open) — click to go back to push-to-talk' : 'Hands-free: keep the mic open'}
          >
            <Lock size={14} />
          </button>
        </>
      ) : (
        <span className="inline-flex h-9 items-center gap-1.5 px-3 text-xs text-dim">
          <Headphones size={14} /> Listening
        </span>
      )}
      <span className="px-1.5 font-mono text-[10px] text-dim" title="Voice links connected">
        {connected}/{Math.max(0, inVoice - 1)}
      </span>
      <button className="grid size-9 place-items-center rounded-full text-dim transition hover:bg-alarm/20 hover:text-alarm" onClick={() => voice.leave()} aria-label="Leave voice" title="Leave voice">
        <PhoneOff size={14} />
      </button>
    </div>
  );
}
