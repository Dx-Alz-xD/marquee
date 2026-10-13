import { BarChart3, ListVideo, MessageCircle, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '../lib/util';
import { useRoom, type Tab } from '../store';
import { Chat } from './Chat';
import { People } from './People';
import { Polls } from './Polls';
import { Queue } from './Queue';

const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: 'chat', label: 'Chat', icon: <MessageCircle size={15} /> },
  { id: 'queue', label: 'Queue', icon: <ListVideo size={15} /> },
  { id: 'polls', label: 'Polls', icon: <BarChart3 size={15} /> },
  { id: 'people', label: 'People', icon: <Users size={15} /> },
];

export function Sidebar() {
  const tab = useRoom((s) => s.ui.tab);
  const setUi = useRoom((s) => s.setUi);
  const unread = useRoom((s) => s.unread);
  const queueLen = useRoom((s) => s.playlist.length);
  const openPolls = useRoom((s) => s.polls.filter((p) => !p.closed).length);

  return (
    <aside className="flex h-[70dvh] min-h-0 flex-col overflow-hidden rounded-3xl border border-seam bg-velvet/85 backdrop-blur lg:h-auto">
      <nav className="grid shrink-0 grid-cols-4 gap-1 border-b border-seam p-1.5" role="tablist">
        {TABS.map((t) => {
          const badge = t.id === 'chat' ? unread : t.id === 'queue' ? queueLen : t.id === 'polls' ? openPolls : 0;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setUi({ tab: t.id })}
              className={cx(
                'relative flex items-center justify-center gap-1.5 rounded-xl py-2 text-xs font-semibold transition',
                tab === t.id ? 'bg-velvet-3 text-paper' : 'text-dim hover:text-paper',
              )}
            >
              {t.icon}
              {t.label}
              {badge > 0 && (
                <span className={cx('grid min-w-4 place-items-center rounded-full px-1 font-mono text-[9px]', t.id === 'chat' ? 'bg-bulb text-ink' : 'bg-white/10 text-dim')}>
                  {badge > 99 ? '99+' : badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>
      <div className="min-h-0 flex-1">
        {tab === 'chat' && <Chat />}
        {tab === 'queue' && <Queue />}
        {tab === 'polls' && <Polls />}
        {tab === 'people' && <People />}
      </div>
    </aside>
  );
}
