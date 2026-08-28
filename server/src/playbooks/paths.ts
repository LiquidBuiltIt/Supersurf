/**
 * Where playbook scripts live and what they are called.
 *
 * The filename IS the address — `meta` carries no `name` field (spec §7.3).
 * `<name>.playbook.js` is the script; `<name>.runs.jsonl` is its append-only
 * run sidecar (spec §7.8), which is why the extension check below is
 * suffix-exact rather than a bare `.js` test.
 *
 * @module playbooks/paths
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export const PLAYBOOK_EXT = '.playbook.js';
export const RUNS_EXT = '.runs.jsonl';

let baseDir = path.join(os.homedir(), '.supersurf', 'playbooks');

/** Test-only override of the playbooks directory. */
export function setPlaybooksDirForTests(dir: string): void {
  baseDir = dir;
}

export function getPlaybooksDir(): string {
  return baseDir;
}

/**
 * Normalize a name to snake_case. Never rejects on shape — the repo rule is
 * normalize, don't fault. Path separators collapse into underscores, so a
 * name can never address a file outside the playbook directory.
 */
export function normalizeName(raw: string): string {
  return raw
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_')
    .toLowerCase();
}

export function playbookFile(name: string): string {
  return path.join(baseDir, `${normalizeName(name)}${PLAYBOOK_EXT}`);
}

export function runsFile(name: string): string {
  return path.join(baseDir, `${normalizeName(name)}${RUNS_EXT}`);
}

/** Basename minus the playbook extension — the inverse of `playbookFile`. */
export function nameFromFile(file: string): string {
  return path.basename(file).slice(0, -PLAYBOOK_EXT.length);
}

/** Absolute paths of every playbook script in the directory, sorted by name. */
export function listPlaybookFiles(): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(baseDir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith(PLAYBOOK_EXT))
    .sort((a, b) => a.localeCompare(b))
    .map((f) => path.join(baseDir, f));
}
