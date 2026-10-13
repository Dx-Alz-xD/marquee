import { GripVertical, HardDrive, Link2, ListPlus, Play, Search, Trash2, Upload, Users } from 'lucide-react';
import { useRef, useState } from 'react';
import type { MediaInput } from '@shared/protocol';
import type { PlaylistItem } from '@shared/types';
import { fmtTime, parseYouTubeId } from '@shared/util';
import { btn, input, SectionLabel, useSession } from '../components/ui';
import { cx, fingerprintFile, fmtBytes } from '../lib/util';
import { canControl, useRoom } from '../store';

export function Queue() {
  const { client } = useSession();
  const playlist = useRoom((s) => s.playlist);
  const currentId = useRoom((s) => s.playback?.media?.id);
  const ctl = useRoom(canControl);
  const you = useRoom((s) => s.you);
  const setUi = useRoom((s) => s.setUi);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-seam p-3">
        <AddMediaForm />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {playlist.length === 0 && (
          <div className="grid h-full place-items-center p-6 text-center text-sm text-faint">
            <div>
              The queue is empty.
              <button className={cx(btn.ghost, 'mx-auto mt-3')} onClick={() => setUi({ discover: true })}>
                <Search size={14} /> Browse movies
              </button>
            </div>
          </div>
        )}
        <ol className="space-y-1">
          {playlist.map((item, i) => (
            <li
              key={item.id}
              draggable={ctl}
              onDragStart={() => setDragId(item.id)}
              onDragEnd={() => {
                setDragId(null);
                setOverId(null);
              }}
              onDragOver={(e) => {
                if (!dragId) return;
                e.preventDefault();
                setOverId(item.id);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (!dragId || dragId === item.id) return;
                // Relative to an anchor item, never an index — safe under concurrent edits.
                const from = playlist.findIndex((x) => x.id === dragId);
                const afterId = from < i ? item.id : (playlist[i - 1]?.id ?? null);
                client.send({ t: 'pl', op: 'move', itemId: dragId, afterId });
                setDragId(null);
                setOverId(null);
              }}
              className={cx(
                'group flex items-center gap-2.5 rounded-xl p-2 transition',
                item.id === currentId ? 'bg-bulb/10 ring-1 ring-bulb/40' : 'hover:bg-white/[0.04]',
                overId === item.id && dragId !== item.id && 'ring-1 ring-beam/60',
                dragId === item.id && 'opacity-40',
              )}
            >
              {ctl && <GripVertical size={14} className="shrink-0 cursor-grab text-faint" />}
              <Thumb item={item} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{item.media.title}</div>
                <div className="truncate font-mono text-[10px] text-faint">
                  {item.id === currentId ? <span className="text-bulb">NOW PLAYING · </span> : `#${i + 1} · `}
                  {item.media.kind === 'local' ? 'own copies' : item.media.kind}
                  {item.media.duration ? ` · ${fmtTime(item.media.duration)}` : ''} · {item.addedByName}
                </div>
              </div>
              <div className="flex shrink-0 opacity-70 transition group-hover:opacity-100">
                {ctl && item.id !== currentId && (
                  <button className={cx(btn.icon, 'size-8')} onClick={() => client.send({ t: 'pl', op: 'play', itemId: item.id })} aria-label="Play now" title="Play now for everyone">
                    <Play size={14} />
                  </button>
                )}
                {(ctl || item.addedBy === you) && (
                  <button className={cx(btn.icon, 'size-8 hover:text-alarm')} onClick={() => client.send({ t: 'pl', op: 'remove', itemId: item.id })} aria-label="Remove" title="Remove from queue">
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function Thumb({ item }: { item: PlaylistItem }) {
  const src = item.media.thumbnail;
  return (
    <div className="relative h-11 w-[72px] shrink-0 overflow-hidden rounded-lg bg-velvet-3">
      {src ? <img src={src} alt="" className="h-full w-full object-cover" loading="lazy" /> : <div className="grid h-full place-items-center text-lg">{item.media.kind === 'local' ? '💾' : '🎞'}</div>}
    </div>
  );
}

// ─── Add anything: links, catalog, or files from your computer ──────────────
export function AddMediaForm({ compact }: { compact?: boolean }) {
  const { client } = useSession();
  const setUi = useRoom((s) => s.setUi);
  const [url, setUrl] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [fileMode, setFileMode] = useState(false);
  const [upload, setUpload] = useState<{ name: string; pct: number } | null>(null);
  const localRef = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);

  async function fromUrl(next: boolean) {
    const u = url.trim();
    if (!u) return;
    setErr(null);
    const yt = parseYouTubeId(u);
    let media: MediaInput | null = null;
    if (yt) {
      let title = 'YouTube video';
      try {
        const r = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${yt}`)}&format=json`);
        if (r.ok) title = (await r.json()).title ?? title;
      } catch {
        /* offline / CORS — keep generic title */
      }
      media = { kind: 'youtube', youtubeId: yt, title };
    } else if (/^https?:\/\//i.test(u)) {
      const name = decodeURIComponent(new URL(u).pathname.split('/').pop() || 'Video');
      media = { kind: /\.m3u8(\?|$)/i.test(u) ? 'hls' : 'file', url: u, title: name.replace(/\.[a-z0-9]+$/i, '').replace(/[._-]+/g, ' ').trim() || 'Video' };
    }
    if (!media) return setErr('Paste a YouTube link or a direct .mp4 / .webm / .m3u8 URL');
    client.send({ t: 'pl', op: 'add', media, next });
    setUrl('');
  }

  async function addLocal(file: File) {
    const fingerprint = await fingerprintFile(file);
    const duration = await probeDuration(file);
    const prev = useRoom.getState().localFile;
    if (prev) URL.revokeObjectURL(prev.url);
    useRoom.setState({ localFile: { name: file.name, size: file.size, fingerprint, url: URL.createObjectURL(file), acceptedFor: null } });
    client.send({
      t: 'pl',
      op: 'add',
      media: { kind: 'local', title: file.name.replace(/\.[a-z0-9]+$/i, ''), local: { name: file.name, size: file.size, fingerprint, duration }, duration },
    });
    setFileMode(false);
  }

  function uploadFile(file: File) {
    setUpload({ name: file.name, pct: 0 });
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/upload?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && setUpload({ name: file.name, pct: Math.round((e.loaded / e.total) * 100) });
    xhr.onload = () => {
      setUpload(null);
      if (xhr.status !== 200) return setErr('Upload failed');
      const r = JSON.parse(xhr.responseText) as { url: string; name: string };
      client.send({ t: 'pl', op: 'add', media: { kind: 'file', url: r.url, title: r.name.replace(/\.[a-z0-9]+$/i, '') } });
      setFileMode(false);
    };
    xhr.onerror = () => {
      setUpload(null);
      setErr('Upload failed — is the server reachable?');
    };
    xhr.send(file);
  }

  return (
    <div className="flex flex-col gap-2">
      {!compact && <SectionLabel>Add to the queue</SectionLabel>}
      <form
        className="flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          void fromUrl(false);
        }}
      >
        <div className="relative flex-1">
          <Link2 size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
          <input className={cx(input, 'pl-8')} value={url} onChange={(e) => (setUrl(e.target.value), setErr(null))} placeholder="Paste a YouTube, .mp4 or .m3u8 link" aria-label="Media link" />
        </div>
        <button type="submit" className={cx(btn.ghost, 'px-3')} disabled={!url.trim()} title="Add to the end of the queue">
          <ListPlus size={15} />
        </button>
        <button type="button" className={cx(btn.ghost, 'px-3')} disabled={!url.trim()} onClick={() => void fromUrl(true)} title="Play next">
          Next
        </button>
      </form>
      <div className="flex flex-wrap gap-1.5">
        {!compact && (
          <button className={btn.chip} onClick={() => setUi({ discover: true })}>
            <Search size={12} /> Browse movies
          </button>
        )}
        <button className={fileMode ? btn.chipOn : btn.chip} onClick={() => setFileMode(!fileMode)}>
          <HardDrive size={12} /> From my computer
        </button>
      </div>
      {fileMode && (
        <div className="grid grid-cols-2 gap-2">
          <button className="rounded-xl border border-seam bg-ink/50 p-3 text-left transition hover:border-bulb/50" onClick={() => localRef.current?.click()}>
            <Users size={16} className="text-bulb" />
            <div className="mt-1.5 text-xs font-semibold">Everyone has a copy</div>
            <div className="mt-0.5 text-[11px] leading-snug text-dim">Each person picks their own file. Nothing uploads; files are matched by fingerprint.</div>
          </button>
          <button className="rounded-xl border border-seam bg-ink/50 p-3 text-left transition hover:border-bulb/50" onClick={() => uploadRef.current?.click()} disabled={!!upload}>
            <Upload size={16} className="text-bulb" />
            <div className="mt-1.5 text-xs font-semibold">Stream it to the room</div>
            <div className="mt-0.5 text-[11px] leading-snug text-dim">Upload once to this server; everyone streams it (fast on the same Wi-Fi).</div>
          </button>
          <input ref={localRef} type="file" accept="video/*,.mkv" className="hidden" onChange={(e) => e.target.files?.[0] && void addLocal(e.target.files[0])} />
          <input ref={uploadRef} type="file" accept="video/*,.mkv" className="hidden" onChange={(e) => e.target.files?.[0] && uploadFile(e.target.files[0])} />
        </div>
      )}
      {upload && (
        <div className="rounded-xl bg-ink/60 p-2.5 text-xs">
          <div className="flex justify-between">
            <span className="truncate">{upload.name}</span>
            <span className="font-mono text-bulb">{upload.pct}%</span>
          </div>
          <div className="mt-1.5 h-1 rounded-full bg-white/10">
            <div className="h-full rounded-full bg-bulb transition-all" style={{ width: `${upload.pct}%` }} />
          </div>
        </div>
      )}
      {err && <div className="text-xs text-alarm">{err}</div>}
    </div>
  );
}

function probeDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    const done = (d: number | null) => {
      URL.revokeObjectURL(url);
      resolve(d);
    };
    v.preload = 'metadata';
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? v.duration : null);
    v.onerror = () => done(null);
    setTimeout(() => done(null), 5000);
    v.src = url;
  });
}

export { fmtBytes };
