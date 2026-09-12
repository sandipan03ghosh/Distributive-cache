import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Dev-server proxy forwards /cache, /metrics, /cluster, and /health
 * straight to the gateway, so the dashboard can call relative paths
 * (`fetch('/cluster')`) without hardcoding a port or dealing with CORS
 * during local development. In production, `VITE_GATEWAY_URL` (see
 * src/api/client.ts) points at the real gateway URL instead.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/cache': 'http://localhost:4000',
      '/metrics': 'http://localhost:4000',
      '/cluster': 'http://localhost:4000',
      '/health': 'http://localhost:4000',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});