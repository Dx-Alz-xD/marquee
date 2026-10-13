// Public link for people outside the LAN: a Cloudflare quick tunnel (free, no
// account, supports WebSockets). The cloudflared binary is fetched from
// Cloudflare's GitHub releases on first use.
import { existsSync } from 'node:fs';

export interface TunnelHandle {
  url: string | null;
  status: 'starting' | 'up' | 'down';
  stop(): void;
}

export async function startTunnel(port: number): Promise<TunnelHandle> {
  const cf = await import('cloudflared');
  if (!existsSync(cf.bin)) {
    console.log('[share] downloading cloudflared (one-time, ~30 MB)…');
    await cf.install(cf.bin);
  }
  const handle: TunnelHandle = { url: null, status: 'starting', stop: () => {} };
  const t = cf.Tunnel.quick(`http://localhost:${port}`);
  handle.stop = () => {
    t.stop();
    handle.status = 'down';
  };
  t.on('url', (url) => {
    handle.url = url;
    handle.status = 'up';
    console.log(`\n  🌍  Public link (share with friends on other networks):\n      ${url}\n`);
  });
  t.on('exit', () => {
    handle.status = 'down';
    console.warn('[share] tunnel closed');
  });
  t.on('error', (e) => console.warn('[share]', e.message));
  return handle;
}
