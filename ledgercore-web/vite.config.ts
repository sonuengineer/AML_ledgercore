import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// No dev proxy: the API sets an explicit CORS allowlist that already contains
// http://localhost:5173, so the browser talks to :4000 directly. A proxy here
// would hide CORS misconfiguration until deploy day.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
