/**
 * The playbook validation cache.
 *
 * Validation is stat-on-tool-call (spec §4): `refreshRegistry()` runs once at
 * the top of `ConnectionManager.callTool()`, and the verdict rides that tool's
 * result. Two gates keep the cost near zero on the common path —
 *
 *   1. `stat` (mtime + size) decides whether to read the file at all;
 *   2. the sha256 content hash decides whether to re-validate.
 *
 * So `touch` costs a stat, and an editor that rewrites identical bytes costs a
 * read. Only genuinely different content pays for a parse.
 *
 * Reads are SYNCHRONOUS on purpose: `statusHeader()` is sync and must be able
 * to see the registry without awaiting anything.
 *
 * @module playbooks/registry
 */

import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { listPlaybookFiles, nameFromFile } from './paths';
import { validateFile as realValidateFile, type ValidationRecord } from '../security/validate';

interface CacheEntry {
  record: ValidationRecord;
  mtimeMs: number;
  size: number;
}

/** file path -> cached validation. */
const cache = new Map<string, CacheEntry>();

let validator: (p: string) => Promise<ValidationRecord> = realValidateFile;

/** Test seam. Pass `null` to restore the real validator. */
export function setValidatorForTests(fn: ((p: string) => Promise<ValidationRecord>) | null): void {
  validator = fn ?? realValidateFile;
}

export function resetRegistryForTests(): void {
  cache.clear();
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Re-sync the cache with the playbooks directory. Never throws — a broken
 * file becomes an invalid record, which is exactly what the agent should be
 * told about, rather than an exception that takes down an unrelated tool call.
 */
export async function refreshRegistry(): Promise<void> {
  const files = listPlaybookFiles();
  const seen = new Set<string>();

  for (const file of files) {
    seen.add(file);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      continue; // vanished between readdir and stat
    }

    const cached = cache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) continue;

    let hash: string;
    try {
      hash = sha256(fs.readFileSync(file));
    } catch {
      continue;
    }

    if (cached && cached.record.hash === hash) {
      // Same bytes, new stat — refresh the gate, keep the verdict.
      cache.set(file, { record: cached.record, mtimeMs: stat.mtimeMs, size: stat.size });
      continue;
    }

    let record: ValidationRecord;
    try {
      record = await validator(file);
    } catch (err: any) {
      record = {
        file,
        name: nameFromFile(file),
        hash,
        valid: false,
        error: err?.message ?? String(err),
        signature: '',
        validatedAt: Date.now(),
      };
    }
    cache.set(file, { record, mtimeMs: stat.mtimeMs, size: stat.size });
  }

  for (const file of [...cache.keys()]) {
    if (!seen.has(file)) cache.delete(file);
  }
}

/** Every known playbook, valid or not, sorted by name. */
export function getRecords(): ValidationRecord[] {
  return [...cache.values()]
    .map(e => e.record)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getRecord(name: string): ValidationRecord | undefined {
  for (const entry of cache.values()) {
    if (entry.record.name === name) return entry.record;
  }
  return undefined;
}

export function getInvalidRecords(): ValidationRecord[] {
  return getRecords().filter(r => !r.valid);
}
