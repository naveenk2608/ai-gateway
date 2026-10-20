import { Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../packages/shared/src/node/logger.js';
import { migrateDatabase } from '../packages/shared/src/node/migrate.js';

/** Defaults match the Compose stack (local-only, no password). CI sets its own values. */
export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://gateway@localhost:5432/gateway';
export const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

function reachable(url: string): Promise<boolean> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve) => {
    const socket = new Socket();
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(2_000, () => done(false));
    socket.once('error', () => done(false));
    socket.connect(Number(port), hostname, () => done(true));
  });
}

/** Fails fast with a clear message when the Compose services are not running. */
export default async function setup(): Promise<void> {
  const down: string[] = [];
  if (!(await reachable(DATABASE_URL))) down.push('Postgres');
  if (!(await reachable(REDIS_URL))) down.push('Redis');
  if (down.length > 0) {
    throw new Error(
      `${down.join(' and ')} not reachable. Start them with \`docker compose up -d\` ` +
        'or set DATABASE_URL / REDIS_URL.',
    );
  }
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.REDIS_URL = REDIS_URL;
  // Tests share one database; each creates its own users and projects, so they never collide.
  await migrateDatabase({
    databaseUrl: DATABASE_URL,
    dir: fileURLToPath(new URL('../db/migrations', import.meta.url)),
    logger: createLogger({ name: 'test-setup', level: 'warn' }),
  });
}
