/**
 * Playbook persistence — ONE FILE PER PLAYBOOK.
 *
 * Deliberately not a single index file. This repo has no file locking anywhere
 * and `writeFileSync` is last-write-wins, so a shared index would silently drop
 * a write whenever the CLI and the MCP server touched it at once — which is the
 * expected flow, since removal is CLI-only while creation is agent-driven.
 * Separate files mean `rm` and `create` never contend unless they name the same
 * playbook, and that case is already an explicit collision error.
 *
 * No memo cache here, unlike `experimental/fingerprinting/store.ts`: playbook
 * reads happen once per `run`, not per DOM node, so a cache would add a
 * staleness class for no measurable gain.
 *
 * @module playbooks/store
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Playbook } from './types';

let baseDir = path.join(os.homedir(), '.supersurf', 'playbooks');

/** Test-only override of the storage directory. */
export function setBaseDirForTests(dir: string): void {
  baseDir = dir;
}

export function getBaseDir(): string {
  return baseDir;
}

/**
 * Normalize a name to snake_case. Never rejects on shape — the repo rule is
 * normalize, don't fault. Path separators are stripped, so a name can never
 * address a file outside the playbook directory.
 */
export function normalizeName(raw: string): string {
  return raw
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_')
    .toLowerCase();
}

function fileFor(name: string): string {
  return path.join(baseDir, `${normalizeName(name)}.json`);
}

export function playbookExists(name: string): boolean {
  return fs.existsSync(fileFor(name));
}

export function loadPlaybook(name: string): Playbook | null {
  try {
    return JSON.parse(fs.readFileSync(fileFor(name), 'utf8')) as Playbook;
  } catch {
    // Missing or unparseable are the same answer to the caller: no playbook.
    return null;
  }
}

/**
 * Write a playbook. Mode 0600 because steps carry the exact params used to
 * re-issue an action, which for a `type` step includes whatever text was typed.
 */
export function savePlaybook(pb: Playbook): void {
  fs.mkdirSync(baseDir, { recursive: true });
  const file = fileFor(pb.name);
  fs.writeFileSync(file, JSON.stringify(pb, null, 2), { mode: 0o600 });
  // mkdir/writeFile honor umask on some platforms; force the mode explicitly.
  fs.chmodSync(file, 0o600);
}

export function removePlaybook(name: string): boolean {
  try {
    fs.unlinkSync(fileFor(name));
    return true;
  } catch {
    return false;
  }
}

/** Every readable playbook. Corrupt files are skipped, not fatal. */
export function listPlaybooks(): Playbook[] {
  let names: string[];
  try {
    names = fs.readdirSync(baseDir);
  } catch {
    return [];
  }
  const out: Playbook[] = [];
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    const pb = loadPlaybook(f.slice(0, -'.json'.length));
    if (pb) out.push(pb);
  }
  return out;
}
