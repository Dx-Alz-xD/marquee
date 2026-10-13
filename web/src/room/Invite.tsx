import { Check, Copy, Globe, Wifi } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useMemo, useState } from 'react';
import { prettyCode } from '@shared/util';
import { btn, Modal, SectionLabel } from '../components/ui';
import { api, copyText, cx, type ServerInfo } from '../lib/util';
import { useRoom } from '../store';

export function InviteModal() {
  const open = useRoom((s) => s.ui.invite);
  const setUi = useRoom((s) => s.setUi);
  const code = useRoom((s) => s.code);
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [which, setWhich] = useState<'lan' | 'public'>('lan');

  useEffect(() => {
    if (!open) return;
    api<ServerInfo>('/api/info').then(setInfo).catch(() => {});
  }, [open]);

  const links = useMemo(() => {
    const path = `/r/${code}`;
    const isLocalhost = /^(localhost|127\.|\[::1\])/.test(location.hostname);
    let lan = `${location.origin}${path}`;
    if (isLocalhost && info?.lanUrls[0]) {
      const u = new URL(info.lanUrls[0]);
      u.port = location.port; // keep the port the page was served from (dev :5173 or prod :3000)
      lan = `${u.origin}${path}`;
    }
    const isPublicOrigin = location.hostname.endsWith('trycloudflare.com');
    const pub = info?.publicUrl ? `${info.publicUrl}${path}` : isPublicOrigin ? `${location.origin}${path}` : null;
    return { lan, pub };
  }, [code, info]);

  useEffect(() => {
    if (links.pub && which === 'lan' && location.hostname.endsWith('trycloudflare.com')) setWhich('public');
  }, [links.pub, which]);

  const url = which === 'public' && links.pub ? links.pub : links.lan;

  return (
    <Modal open={open} onClose={() => setUi({ invite: false })} label="Invite friends" className="max-w-lg">
      <div className="p-6 sm:p-8">
        <SectionLabel>Invite to the room</SectionLabel>
        <div className="mt-3 flex justify-center gap-1.5">
          {prettyCode(code)
            .split('')
            .map((ch, i) =>
              ch === '-' ? (
                <span key={i} className="self-center font-marquee text-3xl text-bulb/60">
                  –
                </span>
              ) : (
                <span key={i} className="tile grid h-14 w-10 place-items-center text-4xl">
                  {ch}
                </span>
              ),
            )}
        </div>
        <div className="mt-6 grid grid-cols-2 gap-1 rounded-xl bg-ink/60 p-1">
          <button onClick={() => setWhich('lan')} className={cx('inline-flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-semibold', which === 'lan' ? 'bg-velvet-3 text-bulb' : 'text-dim')}>
            <Wifi size={13} /> Same Wi-Fi
          </button>
          <button onClick={() => setWhich('public')} className={cx('inline-flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-semibold', which === 'public' ? 'bg-velvet-3 text-bulb' : 'text-dim')}>
            <Globe size={13} /> Anywhere
          </button>
        </div>
        {which === 'public' && !links.pub ? (
          <div className="mt-5 rounded-2xl border border-seam bg-ink/50 p-4 text-sm text-dim">
            <div className="font-semibold text-paper">Friends on a different network?</div>
            Restart the server with a public link:
            <pre className="mt-2 rounded-lg bg-black/60 p-2.5 font-mono text-xs text-bulb">npm run share</pre>
            It opens a free Cloudflare tunnel (no account needed) and shows the link here. Everyone — same Wi-Fi or not — stays in the same synced room.
            {info?.tunnel === 'starting' && <div className="mt-2 text-beam">Tunnel is starting… reopen this in a few seconds.</div>}
          </div>
        ) : (
          <InviteLink url={url} />
        )}
      </div>
    </Modal>
  );
}

function InviteLink({ url }: { url: string }) {
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    QRCode.toDataURL(url, { margin: 1, width: 360, color: { dark: '#1a1016', light: '#f4ecdf' } })
      .then(setQr)
      .catch(() => setQr(null));
  }, [url]);
  return (
    <div className="mt-5 flex flex-col items-center gap-4 sm:flex-row sm:items-start">
      {qr ? <img src={qr} alt="QR code for the invite link" className="size-40 shrink-0 rounded-2xl" /> : <div className="skeleton size-40 rounded-2xl" />}
      <div className="min-w-0 flex-1">
        <div className="text-sm text-dim">Scan with a phone camera, or send the link:</div>
        <div className="mt-2 rounded-xl border border-seam bg-ink/60 p-2.5 font-mono text-xs break-all text-paper">{url}</div>
        <button
          className={cx(btn.primary, 'mt-3 w-full')}
          onClick={async () => {
            if (await copyText(url)) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1800);
            }
          }}
        >
          {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? 'Copied' : 'Copy invite link'}
        </button>
      </div>
    </div>
  );
}
