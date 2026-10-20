import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, '');
  const gatewayUrl = env.GATEWAY_URL ?? 'http://localhost:8080';

  return {
    plugins: [react()],
    server: {
      port: 5173,
      // Same-origin /api in dev and in the nginx container, so session cookies (M5) just work.
      proxy: {
        '/api': {
          target: gatewayUrl,
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
      },
    },
  };
});
