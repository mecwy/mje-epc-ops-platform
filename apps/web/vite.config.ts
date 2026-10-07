import { resolve } from 'node:path';
import { defineConfig } from 'vite';
const apiPort = Number(process.env['DEV_API_PORT'] ?? '3300');
if (!Number.isInteger(apiPort) || apiPort < 1024 || apiPort > 65535)
  throw new Error('DEV_API_PORT');
export default defineConfig({
  build: {
    rollupOptions: {
      // Two pages: the signed-in app and the field device page at /field/ (no sign-in, no MSAL).
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        field: resolve(import.meta.dirname, 'field/index.html'),
      },
    },
  },
  server: {
    port: 5178,
    strictPort: true,
    proxy: {
      '/health': `http://127.0.0.1:${apiPort}`,
      '/api': `http://127.0.0.1:${apiPort}`,
    },
  },
});
