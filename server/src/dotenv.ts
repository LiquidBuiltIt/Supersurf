/**
 * Minimal .env file loader. Reads KEY=VALUE pairs from a .env file into process.env.
 * Does not override existing vars. Tracks loaded key names for credential discovery.
 *
 * @module dotenv
 */

import fs from 'fs';
import path from 'path';

/** Keys loaded from .env — only names, never values. */
const dotenvKeys: string[] = [];

/** Get the list of env var names loaded from .env. */
export function getDotenvKeys(): string[] {
  return dotenvKeys;
}

/**
 * Load a .env file into process.env. Does not override existing vars.
 * Supports KEY=VALUE, KEY="VALUE", KEY='VALUE', comments (#), and blank lines.
 */
export function loadDotenv(dir: string): void {
  const envPath = path.join(dir, '.env');
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();

    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }

    // Don't override existing env vars
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
    dotenvKeys.push(key);
  }
}
