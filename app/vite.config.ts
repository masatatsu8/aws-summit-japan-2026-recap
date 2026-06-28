import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SIDECAR_PORT = Number(process.env.SIDECAR_PORT || 3001);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://localhost:${SIDECAR_PORT}`,
        changeOrigin: true,
        // SSE 用に buffer 無効化
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            proxyRes.headers['x-accel-buffering'] = 'no';
          });
        },
      },
    },
  },
});
