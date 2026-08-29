/**
 * Playbook file validation — read, hash, parse meta, static-analyze.
 *
 * All three gates must pass for `valid: true`:
 *   1. `parseMeta` — the meta literal is present, pure, and well-shaped
 *   2. `analyzeWithRules(source, nodeRules)` — no blocked Node constructs
 *   3. the declared-vs-used permission check — a file that calls
 *      `supersurf.evaluate` must declare `permissions: ['eval']`
 *
 * A record is returned for every outcome. `file`, `name`, `hash` and
 * `signature` are always populated so a caller can list a broken playbook
 * alongside the reason it is broken.
 *
 * @module security/validate
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { analyzeWithRules } from './analyzer';
import { nodeRules, evalUsageRules } from './rules/node';
import { parseMeta, type PlaybookMeta } from './meta';

/** The outcome of validating one playbook file. */
export interface ValidationRecord {
  file: string;          // absolute path
  name: string;          // basename minus '.playbook.js'
  hash: string;          // sha256 of file contents
  valid: boolean;
  error?: string;        // present iff valid === false
  meta?: PlaybookMeta;   // present iff valid === true
  signature: string;     // e.g. 'post_tweet(text)' — 'post_tweet()' when no params
  validatedAt: number;   // epoch ms
}

/** Strip the `.playbook.js` suffix from a path to get the playbook's name. */
export function playbookName(filePath: string): string {
  return path.basename(filePath).replace(/\.playbook\.js$/, '');
}

/** Render the one-line call signature: `post_tweet(text, pin?)`. */
export function buildSignature(name: string, meta?: PlaybookMeta): string {
  const params = meta?.params ?? {};
  const rendered = Object.entries(params).map(([k, spec]) => (spec.required ? k : `${k}?`));
  return `${name}(${rendered.join(', ')})`;
}

/** Read, hash, parse and statically analyze one playbook file. Never throws. */
export async function validateFile(filePath: string): Promise<ValidationRecord> {
  const name = playbookName(filePath);
  const base = {
    file: filePath,
    name,
    signature: buildSignature(name),
    validatedAt: Date.now(),
  };

  let source: string;
  try {
    source = await fs.readFile(filePath, 'utf8');
  } catch (e: any) {
    return { ...base, hash: '', valid: false, error: `could not read ${filePath}: ${e?.message ?? String(e)}` };
  }

  const hash = crypto.createHash('sha256').update(source).digest('hex');

  const { meta, error } = parseMeta(source);
  if (!meta) {
    return { ...base, hash, valid: false, error };
  }

  const analysis = analyzeWithRules(source, nodeRules);
  if (!analysis.safe) {
    return { ...base, hash, valid: false, error: `blocked: ${analysis.reason}` };
  }

  if (!(meta.permissions ?? []).includes('eval')) {
    const evalUse = analyzeWithRules(source, evalUsageRules);
    if (!evalUse.safe) {
      return { ...base, hash, valid: false, error: `blocked: ${evalUse.reason}` };
    }
  }

  return { ...base, hash, valid: true, meta, signature: buildSignature(name, meta) };
}
