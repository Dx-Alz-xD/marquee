import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const serverPort = Number(process.env.MARQUEE_PORT ?? 3000);

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('./shared', import.meta.url)) },
  },
  server: {
    host: true,
    port: 5173,
    fs: { allow: ['..'] },
    proxy: {
      '/api': `http://localhost:${serverPort}`,
      '/media': `http://localhost:${serverPort}`,
      '/metrics': `http://localhost:${serverPort}`,
      '/ws': { target: `ws://localhost:${serverPort}`, ws: true },
    },
  },
  build: { outDir: '../dist', emptyOutDir: true, chunkSizeWarningLimit: 1200 },
});
