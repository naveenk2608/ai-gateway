/**
 * `pnpm key:generate`: prints a new random API key in the gateway format, for BOOTSTRAP_API_KEY.
 * Nothing is stored; the gateway imports the key at startup.
 */
import { generateApiKey } from '../auth/api-keys.js';

process.stdout.write(`${generateApiKey().plaintext}\n`);
