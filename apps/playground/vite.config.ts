import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// A static site: it calls the gateway it is pointed at directly, so there is no dev proxy. A local
// gateway needs this dev server's origin in ALLOWED_ORIGINS (http://localhost:5174).
export default defineConfig({
  plugins: [react()],
  server: { port: 5174, strictPort: true },
});
