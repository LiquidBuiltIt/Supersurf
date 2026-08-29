import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { validateFile, buildSignature } from '../src/security/validate';

let dir: string;

/** Write a playbook file into the temp dir and return its absolute path. */
function write(name: string, source: string): string {
  const p = path.join(dir, `${name}.playbook.js`);
  fs.writeFileSync(p, source, 'utf8');
  return p;
}

const GOOD = `export const meta = {
  description: 'Post a tweet',
  params: { text: { type: 'string', required: true }, pin: { type: 'boolean' } },
  profile: 'developer',
  startingPoint: 'x.com',
};

export default async function ({ supersurf, params }) {
  await supersurf.goto('https://x.com/compose/post');
  await supersurf.type('[role="textbox"]', params.text);
  return { ok: true };
}
`;

beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-validate-')); });
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('validateFile — valid file', () => {
  it('returns a valid record with meta, hash and signature', async () => {
    const file = write('post_tweet', GOOD);
    const rec = await validateFile(file);
    expect(rec.valid).toBe(true);
    expect(rec.error).toBeUndefined();
    expect(rec.file).toBe(file);
    expect(rec.name).toBe('post_tweet');
    expect(rec.hash).toBe(crypto.createHash('sha256').update(GOOD).digest('hex'));
    expect(rec.signature).toBe('post_tweet(text, pin?)');
    expect(rec.meta?.description).toBe('Post a tweet');
    expect(rec.validatedAt).toBeGreaterThan(0);
  });

  it('renders an empty signature when there are no params', async () => {
    const file = write('ping', `export const meta = { description: 'Ping' };\nexport default async function () { return 1; }\n`);
    const rec = await validateFile(file);
    expect(rec.valid).toBe(true);
    expect(rec.signature).toBe('ping()');
  });
});

describe('validateFile — invalid files', () => {
  it('rejects a missing file', async () => {
    const rec = await validateFile(path.join(dir, 'nope.playbook.js'));
    expect(rec.valid).toBe(false);
    expect(rec.error).toContain('could not read');
    expect(rec.meta).toBeUndefined();
    expect(rec.signature).toBe('nope()');
  });

  it('rejects a bad meta literal', async () => {
    const file = write('bad_meta', `export const meta = { params: buildParams() };\nexport default async function () {}\n`);
    const rec = await validateFile(file);
    expect(rec.valid).toBe(false);
    expect(rec.error).toContain('literal');
  });

  it('rejects a non-boolean meta.experiments', async () => {
    const file = write('bad_experiments', `export const meta = { description: 'x', experiments: 'all' };\nexport default async function () {}\n`);
    const rec = await validateFile(file);
    expect(rec.valid).toBe(false);
    expect(rec.error).toContain('experiments must be a boolean');
  });

  it('carries meta.experiments through to the record', async () => {
    const file = write('with_experiments', `export const meta = { description: 'x', experiments: true };\nexport default async function () {}\n`);
    const rec = await validateFile(file);
    expect(rec.valid).toBe(true);
    expect(rec.meta!.experiments).toBe(true);
    // Plan 2 stops here. Turning the experiments on for the run's session is
    // Plan 3's job — that is where the ConnectionManager lives.
  });

  it('rejects blocked Node constructs', async () => {
    const file = write('bad_code', `export const meta = { description: 'x' };\nexport default async function () { require('fs'); }\n`);
    const rec = await validateFile(file);
    expect(rec.valid).toBe(false);
    expect(rec.error).toContain('require()');
  });

  it('rejects supersurf.evaluate without the eval permission', async () => {
    const file = write('needs_eval', `export const meta = { description: 'x' };\nexport default async function ({ supersurf }) { await supersurf.evaluate('1'); }\n`);
    const rec = await validateFile(file);
    expect(rec.valid).toBe(false);
    expect(rec.error).toContain('permissions');
  });

  it('accepts supersurf.evaluate WITH the eval permission', async () => {
    const file = write('has_eval', `export const meta = { description: 'x', permissions: ['eval'] };\nexport default async function ({ supersurf }) { await supersurf.evaluate('1'); }\n`);
    const rec = await validateFile(file);
    expect(rec.valid).toBe(true);
  });

  it('always sets file, name, hash and signature even when invalid', async () => {
    const file = write('broken', `export const meta = {`);
    const rec = await validateFile(file);
    expect(rec.valid).toBe(false);
    expect(rec.name).toBe('broken');
    expect(rec.hash).toHaveLength(64);
    expect(rec.signature).toBe('broken()');
  });
});

describe('buildSignature', () => {
  it('marks optional params with a trailing ?', () => {
    expect(buildSignature('x', {
      description: 'd',
      params: { a: { type: 'string', required: true }, b: { type: 'number' }, c: { type: 'boolean', required: false } },
    })).toBe('x(a, b?, c?)');
  });

  it('renders bare parens with no meta at all', () => {
    expect(buildSignature('x')).toBe('x()');
  });
});
