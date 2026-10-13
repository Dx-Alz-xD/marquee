import { AVATARS, COLORS } from '@shared/util';
import { cx, type Identity } from '../lib/util';
import { Avatar, input, SectionLabel } from './ui';

export function IdentityPicker({ value, onChange, autoFocus }: { value: Identity; onChange: (i: Identity) => void; autoFocus?: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Avatar m={{ ...value, name: value.name || 'You' }} size={52} />
        <div className="flex-1">
          <label className="mb-1.5 block" htmlFor="display-name">
            <SectionLabel>Your name in the room</SectionLabel>
          </label>
          <input
            id="display-name"
            className={input}
            value={value.name}
            maxLength={32}
            placeholder="e.g. Priya"
            autoFocus={autoFocus}
            autoComplete="nickname"
            onChange={(e) => onChange({ ...value, name: e.target.value })}
          />
        </div>
      </div>
      <div>
        <SectionLabel className="mb-2">Avatar</SectionLabel>
        <div className="grid grid-cols-8 gap-1.5">
          {AVATARS.map((a) => (
            <button
              key={a}
              type="button"
              aria-label={`Avatar ${a}`}
              aria-pressed={value.avatar === a}
              onClick={() => onChange({ ...value, avatar: a })}
              className={cx(
                'grid aspect-square place-items-center rounded-xl text-xl transition',
                value.avatar === a ? 'bg-bulb/20 ring-2 ring-bulb' : 'bg-velvet-2 hover:bg-velvet-3',
              )}
            >
              {a}
            </button>
          ))}
        </div>
      </div>
      <div>
        <SectionLabel className="mb-2">Seat color</SectionLabel>
        <div className="flex flex-wrap gap-2">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Color ${c}`}
              aria-pressed={value.color === c}
              onClick={() => onChange({ ...value, color: c })}
              className={cx('size-7 rounded-full transition', value.color === c ? 'scale-110 ring-2 ring-paper ring-offset-2 ring-offset-velvet' : 'hover:scale-110')}
              style={{ background: c }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
