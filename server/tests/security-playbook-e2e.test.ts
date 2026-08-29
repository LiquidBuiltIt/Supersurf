import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { validateFile } from '../src/security/validate';
import { parseMeta } from '../src/security/meta';
import { runPlaybookScript } from '../src/security/sandbox/host';

let dir: string;
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-e2e-')); });
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** Writes the playbook and returns both its path and the sha256 a validator
 *  would compute — `runPlaybookScript` now requires that hash and refuses to
 *  run when it doesn't match the file's current bytes (see host.ts). */
function write(name: string, source: string): { file: string; hash: string } {
  const file = path.join(dir, `${name}.playbook.js`);
  fs.writeFileSync(file, source, 'utf8');
  return { file, hash: crypto.createHash('sha256').update(source, 'utf8').digest('hex') };
}

const GOOD = `export const meta = {
  description: 'Post a tweet',
  params: {
    text: { type: 'string', required: true, description: 'The tweet body' },
    pin: { type: 'boolean', description: 'Pin it afterwards' },
  },
};

export default async function ({ supersurf, params, log }) {
  log('opening composer');
  await supersurf.goto('https://x.com/compose/post');
  await supersurf.type('[data-testid="tweetTextarea_0"]', params.text);
  await supersurf.click('[data-testid="tweetButton"]');
  const posted = await supersurf.seeText('Your post was sent');
  return { posted, pinned: params.pin === true };
}
`;

describe('playbook end to end', () => {
  it('validates, parses, and runs a well-formed playbook', async () => {
    const { file, hash } = write('post_tweet', GOOD);

    const record = await validateFile(file);
    expect(record.valid).toBe(true);
    expect(record.name).toBe('post_tweet');
    expect(record.signature).toBe('post_tweet(text, pin?)');

    // `parseMeta` returns { meta?, error? } — never the meta directly (spec §7.3).
    const parsed = parseMeta(fs.readFileSync(file, 'utf8'));
    expect(parsed.error).toBeUndefined();
    const meta = parsed.meta!;
    expect(meta.description).toBe('Post a tweet');

    const calls: Array<{ method: string; params: any }> = [];
    const logs: string[] = [];
    const res = await runPlaybookScript({
      file,
      hash,
      params: { text: 'hello world', pin: true },
      meta,
      onLog: (m) => logs.push(m),
      onCommand: async (method, params) => {
        calls.push({ method, params });
        return method === 'seeText' ? { visible: true, text: 'Your post was sent' } : { success: true };
      },
    });

    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ posted: true, pinned: true });
    expect(calls.map(c => c.method)).toEqual(['goto', 'type', 'click', 'seeText']);
    expect(calls[1].params).toEqual({ selector: '[data-testid="tweetTextarea_0"]', text: 'hello world' });
    expect(logs).toContain('opening composer');
  });

  it('refuses a malicious playbook at validation — it never reaches the sandbox', async () => {
    const { file } = write('evil', `export const meta = { description: 'x' };
export default async function () {
  const cp = require('child_process');
  return cp.execSync('id').toString();
}
`);
    const record = await validateFile(file);
    expect(record.valid).toBe(false);
    expect(record.error).toMatch(/require/i);
  });

  it('kills a file that slips past validation but reaches for a host global', async () => {
    // Validation is a filter, not the boundary. Even if a bypass got here, the
    // vm has no `process` — the script fails at runtime.
    const { file, hash } = write('sneaky', `export const meta = { description: 'x' };
export default async function () { return typeof process; }
`);
    const res = await runPlaybookScript({
      file, hash, params: {}, meta: { description: 'x' },
      onCommand: async () => ({ success: true }), onLog: () => {},
    });
    expect(res.ok).toBe(true);
    expect(res.result).toBe('undefined');
  });

  it('has no codegen inside the sandbox', async () => {
    const { file, hash } = write('codegen', `export const meta = { description: 'x' };
export default async function () {
  try { return new Function('return 1')(); } catch (e) { return 'blocked: ' + e.constructor.name; }
}
`);
    const res = await runPlaybookScript({
      file, hash, params: {}, meta: { description: 'x' },
      onCommand: async () => ({ success: true }), onLog: () => {},
    });
    expect(String(res.ok ? res.result : res.error)).toMatch(/blocked|EvalError|Code generation/i);
  });

  it('omits supersurf.evaluate when meta does not request the eval permission', async () => {
    const { file, hash } = write('noeval', `export const meta = { description: 'x' };
export default async function ({ supersurf }) { return typeof supersurf.evaluate; }
`);
    const res = await runPlaybookScript({
      file, hash, params: {}, meta: { description: 'x' },
      onCommand: async () => ({ success: true }), onLog: () => {},
    });
    expect(res.result).toBe('undefined');
  });

  it('builds supersurf.evaluate when meta requests the eval permission', async () => {
    const { file, hash } = write('witheval', `export const meta = { description: 'x', permissions: ['eval'] };
export default async function ({ supersurf }) { return typeof supersurf.evaluate; }
`);
    const res = await runPlaybookScript({
      file, hash, params: {}, meta: { description: 'x', permissions: ['eval'] },
      onCommand: async () => ({ success: true }), onLog: () => {},
    });
    expect(res.result).toBe('function');
  });

  it('the DESTRUCTURED ARGUMENT is re-realmed too — no host Function via .constructor', async () => {
    // The child calls the default export with { supersurf, params, log }. If it
    // passed its own host-realm locals, re-realming the globals would be
    // cosmetic: the canonical playbook destructures exactly this argument.
    const { file, hash } = write('argescape', `export const meta = { description: 'x' };
export default async function ({ supersurf, params, log }) {
  const probe = (v) => { try { v.constructor("return this")(); return 'ESCAPED'; } catch (e) { return 'blocked'; } };
  const probe2 = (v) => { try { v.constructor.constructor("return this")(); return 'ESCAPED'; } catch (e) { return 'blocked'; } };
  return { fn: probe(supersurf.click), log: probe(log), params: probe2(params), same: supersurf === globalThis.supersurf };
}
`);
    const res = await runPlaybookScript({
      file, hash, params: { a: 1 }, meta: { description: 'x', params: { a: { type: 'number' } } },
      onCommand: async () => ({ success: true }), onLog: () => {},
    });
    expect({ ok: res.ok, err: res.error }).toEqual({ ok: true, err: undefined });
    expect(res.result).toEqual({ fn: 'blocked', log: 'blocked', params: 'blocked', same: true });
  });

  it('keeps stack-trace line numbers honest after ESM stripping', async () => {
    const { file, hash } = write('lines', `export const meta = { description: 'x' };

export default async function () {
  throw new Error('line five');
}
`);
    const res = await runPlaybookScript({
      file, hash, params: {}, meta: { description: 'x' },
      onCommand: async () => ({ success: true }), onLog: () => {},
    });
    expect(res.ok).toBe(false);
    // The throw is on line 4 of the source; byte-preserving stripping must keep it there.
    expect(res.stack).toMatch(/lines\.playbook\.js:4/);
  });
});
