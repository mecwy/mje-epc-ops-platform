import { resolve } from 'node:path';
import { defineConfig } from 'vite';
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
      '/health': 'http://127.0.0.1:3300',
      '/api': 'http://127.0.0.1:3300',
    },
  },
});
