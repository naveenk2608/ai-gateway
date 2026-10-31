import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, '');
  const gatewayUrl = env.GATEWAY_URL ?? 'http://localhost:8080';

  // The gateway serves the build at /dashboard/ (DASHBOARD_DIR). In development the gateway's
  // paths are proxied, so the API is same-origin there too and session cookies just work.
  const toGateway = { target: gatewayUrl };
  return {
    base: '/dashboard/',
    plugins: [react()],
    server: {
      port: 5173,
      proxy: { '/admin': toGateway, '/v1': toGateway, '/ready': toGateway },
    },
  };
});
