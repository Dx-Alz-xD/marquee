import { useEffect, useState } from 'react';
import { btn, input, Modal, SectionLabel, useSession } from '../components/ui';
import { cx } from '../lib/util';
import { useRoom } from '../store';

export function SettingsModal() {
  const { client } = useSession();
  const open = useRoom((s) => s.ui.settings);
  const setUi = useRoom((s) => s.setUi);
  const settings = useRoom((s) => s.settings);
  const [name, setName] = useState(settings?.name ?? '');
  useEffect(() => setName(settings?.name ?? ''), [settings?.name, open]);
  if (!settings) return null;
  const patch = (p: Record<string, unknown>) => client.send({ t: 'settings', patch: p });

  return (
    <Modal open={open} onClose={() => setUi({ settings: false })} label="Room settings" className="max-w-md">
      <div className="space-y-5 p-6 sm:p-8">
        <div className="font-serif text-2xl">Room settings</div>
        <div>
          <SectionLabel className="mb-1.5">Room name</SectionLabel>
          <div className="flex gap-2">
            <input className={input} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
            <button className={btn.ghost} disabled={!name.trim() || name === settings.name} onClick={() => patch({ name: name.trim() })}>
              Save
            </button>
          </div>
        </div>
        <Choice
          label="Who holds the remote"
          value={settings.controlMode}
          onChange={(v) => patch({ controlMode: v })}
          options={[
            ['everyone', 'Everyone', 'Anyone can play, pause and seek.'],
            ['host', 'Hosts only', 'Only the host and co-hosts control playback.'],
            ['democracy', 'Majority vote', 'Members’ presses start a 15 s vote; a majority applies it.'],
          ]}
        />
        <Choice
          label="When someone is buffering"
          value={settings.syncPolicy}
          onChange={(v) => patch({ syncPolicy: v })}
          options={[
            ['strict', 'Wait for them', 'Room pauses (max 10 s), then resumes with a countdown.'],
            ['relaxed', 'Keep going', 'They catch up automatically when their video recovers.'],
          ]}
        />
        <label className="flex cursor-pointer items-center gap-3 text-sm">
          <input type="checkbox" checked={settings.autoplayNext} onChange={(e) => patch({ autoplayNext: e.target.checked })} className="size-4 accent-[var(--color-bulb)]" />
          Auto-play the next item in the queue (8 s countdown)
        </label>
      </div>
    </Modal>
  );
}

function Choice({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string, string][] }) {
  return (
    <div>
      <SectionLabel className="mb-1.5">{label}</SectionLabel>
      <div className="space-y-1.5">
        {options.map(([v, title, desc]) => (
          <button key={v} onClick={() => onChange(v)} className={cx('w-full rounded-xl border p-3 text-left transition', value === v ? 'border-bulb/60 bg-bulb/10' : 'border-seam hover:border-faint')}>
            <div className={cx('text-sm font-semibold', value === v && 'text-bulb')}>{title}</div>
            <div className="text-xs text-dim">{desc}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
