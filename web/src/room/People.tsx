import { Crown, Star } from 'lucide-react';
import { useMemo } from 'react';
import { Avatar, btn, SectionLabel, useSession } from '../components/ui';
import { cx } from '../lib/util';
import { useRoom } from '../store';
import { syncTone } from './TheaterRow';

export function People() {
  const { client } = useSession();
  const members = useRoom((s) => s.members);
  const telemetry = useRoom((s) => s.telemetry);
  const you = useRoom((s) => s.you);
  const settings = useRoom((s) => s.settings);
  const me = you ? members[you] : null;
  const catalog = useMemo(() => Object.values(members).sort((a, b) => Number(b.online) - Number(a.online) || a.joinedAt - b.joinedAt), [members]);
  const modeLabel = { host: 'Only hosts control playback', everyone: 'Everyone can control playback', democracy: 'Majority vote controls playback' }[settings?.controlMode ?? 'everyone'];

  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="mb-3 rounded-2xl bg-ink/40 px-3.5 py-2.5 text-xs text-dim">
        {modeLabel} · {settings?.syncPolicy === 'strict' ? 'room waits for buffering' : 'buffering members catch up'}
      </div>
      <SectionLabel className="mb-2 px-1">{catalog.filter((m) => m.online).length} watching</SectionLabel>
      <ul className="space-y-1">
        {catalog.map((m) => {
          const t = telemetry[m.id];
          const tone = syncTone(m, t);
          return (
            <li key={m.id} className={cx('flex items-center gap-3 rounded-xl px-2 py-2', !m.online && 'opacity-50')}>
              <Avatar m={m} size={36} ring={tone.color} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-sm font-medium">
                  <span className="truncate">{m.name}</span>
                  {m.id === you && <span className="text-xs text-faint">(you)</span>}
                  {m.role === 'host' && <Crown size={13} className="fill-bulb text-bulb" />}
                  {m.role === 'cohost' && <Star size={12} className="fill-bulb/70 text-bulb/70" />}
                </div>
                <div className="truncate font-mono text-[10px]" style={{ color: tone.color }}>
                  {tone.label}
                  {t?.rtt != null && m.online && <span className="text-faint"> · rtt {Math.round(t.rtt)} ms</span>}
                  {m.browsing && <span className="text-faint"> · browsing</span>}
                </div>
              </div>
              {me?.role === 'host' && m.id !== you && m.online && (
                <button className={cx(btn.chip, 'shrink-0')} onClick={() => client.send({ t: 'role', op: 'transfer', target: m.id })} title={`Make ${m.name} the host`}>
                  <Crown size={11} /> Give remote
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
