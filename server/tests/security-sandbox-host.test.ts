import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import {
  runPlaybookScript,
  validateParams,
  permissionFlagsFor,
  resolveChildEntry,
  checkChildEntrySandboxing,
} from '../src/security/sandbox/host';
import type { PlaybookMeta } from '../src/security/meta';

let dir: string;
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-host-')); });
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function sha256(source: string): string {
  return crypto.createHash('sha256').update(source, 'utf8').digest('hex');
}

/** Writes the playbook and returns both its path and the hash a validator
 *  would have computed for it — `runPlaybookScript` now requires that hash
 *  and refuses to run when it doesn't match what's on disk. */
function write(name: string, source: string): { file: string; hash: string } {
  const file = path.join(dir, `${name}.playbook.js`);
  fs.writeFileSync(file, source, 'utf8');
  return { file, hash: sha256(source) };
}

const META: PlaybookMeta = { description: 'test' };
const noCommands = async () => { throw new Error('no command expected'); };
const noLogs = () => {};

describe('validateParams', () => {
  const meta: PlaybookMeta = {
    description: 'x',
    params: { text: { type: 'string', required: true }, count: { type: 'number' }, pin: { type: 'boolean' } },
  };

  it('accepts a valid set', () => {
    expect(validateParams({ text: 'a', count: 2, pin: true }, meta)).toBeNull();
  });

  it('accepts omitted optional params', () => {
    expect(validateParams({ text: 'a' }, meta)).toBeNull();
  });

  it('reports a missing required param', () => {
    expect(validateParams({}, meta)).toContain('text');
  });

  it('reports a wrong type', () => {
    expect(validateParams({ text: 1 }, meta)).toContain('string');
  });

  it('reports an unknown param', () => {
    expect(validateParams({ text: 'a', nope: 1 }, meta)).toContain('nope');
  });

  it('accepts anything when meta declares no params', () => {
    expect(validateParams({}, META)).toBeNull();
  });
});

describe('permissionFlagsFor', () => {
  it('uses the stable flag on Node 23+', () => {
    const flags = permissionFlagsFor('v23.1.0', '/srv/dist/security/sandbox/child.js');
    expect(flags[0]).toBe('--permission');
    expect(flags.some(f => f.startsWith('--allow-fs-read='))).toBe(true);
  });

  it('uses the experimental flag on Node 20-22', () => {
    expect(permissionFlagsFor('v20.11.0', '/srv/dist/child.js')[0]).toBe('--experimental-permission');
    expect(permissionFlagsFor('v22.0.0', '/srv/dist/child.js')[0]).toBe('--experimental-permission');
  });

  it('returns no flags below Node 20', () => {
    expect(permissionFlagsFor('v18.20.0', '/srv/dist/child.js')).toEqual([]);
  });

  it('NEVER grants filesystem write', () => {
    for (const v of ['v20.0.0', 'v22.0.0', 'v24.0.0']) {
      expect(permissionFlagsFor(v, '/srv/dist/child.js').some(f => f.startsWith('--allow-fs-write'))).toBe(false);
    }
  });

  it('returns no flags for the TypeScript dev entry — tsx needs the loader', () => {
    expect(permissionFlagsFor('v24.0.0', '/srv/src/security/sandbox/child.ts')).toEqual([]);
  });
});

describe('resolveChildEntry', () => {
  it('resolves a child entry that exists on disk', () => {
    const { command, argv, entry } = resolveChildEntry();
    expect(command).toBeTruthy();
    expect(argv.length).toBeGreaterThan(0);
    expect(entry.endsWith('child.js') || entry.endsWith('child.ts')).toBe(true);
    expect(fs.existsSync(entry)).toBe(true);
  });

  it('prefers the compiled child.js when the build output exists', () => {
    const compiled = path.resolve(__dirname, '..', 'dist', 'security', 'sandbox', 'child.js');
    if (!fs.existsSync(compiled)) return; // unbuilt checkout: the tsx fallback is the only option
    expect(resolveChildEntry().entry).toBe(compiled);
  });

  it('runs the compiled child under plain node, with no tsx loader in argv', () => {
    const { command, argv, entry } = resolveChildEntry();
    if (!entry.endsWith('child.js')) return; // unbuilt checkout
    expect(command).toBe(process.execPath);
    expect(argv).toEqual([entry]);
    expect(argv.some(a => a.includes('tsx'))).toBe(false);
  });
});

describe('checkChildEntrySandboxing', () => {
  const ORIGINAL = process.env.SUPERSURF_ALLOW_UNSANDBOXED_PLAYBOOK;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.SUPERSURF_ALLOW_UNSANDBOXED_PLAYBOOK;
    else process.env.SUPERSURF_ALLOW_UNSANDBOXED_PLAYBOOK = ORIGINAL;
  });

  it('lets a compiled child.js through untouched', () => {
    expect(checkChildEntrySandboxing('/srv/dist/security/sandbox/child.js', noLogs)).toBeNull();
  });

  it('refuses the tsx fallback by default', () => {
    delete process.env.SUPERSURF_ALLOW_UNSANDBOXED_PLAYBOOK;
    const err = checkChildEntrySandboxing('/srv/src/security/sandbox/child.ts', noLogs);
    expect(err).toContain('npm run build');
    expect(err).toContain('SUPERSURF_ALLOW_UNSANDBOXED_PLAYBOOK');
    // The fix-it instruction must come before the escape hatch, or an agent
    // skims to the env var and never builds.
    expect(err!.indexOf('npm run build')).toBeLessThan(err!.indexOf('SUPERSURF_ALLOW_UNSANDBOXED_PLAYBOOK'));
  });

  it('proceeds when the opt-out is set, but logs an unmissable warning', () => {
    process.env.SUPERSURF_ALLOW_UNSANDBOXED_PLAYBOOK = '1';
    const logs: string[] = [];
    const err = checkChildEntrySandboxing('/srv/src/security/sandbox/child.ts', (m) => logs.push(m));
    expect(err).toBeNull();
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain('SECURITY');
    expect(logs[0]).toContain('UNRESTRICTED');
  });

  it('does not treat an unrelated opt-out value as consent', () => {
    process.env.SUPERSURF_ALLOW_UNSANDBOXED_PLAYBOOK = 'true'; // not the literal '1'
    expect(checkChildEntrySandboxing('/srv/src/security/sandbox/child.ts', noLogs)).not.toBeNull();
  });
});

describe('runPlaybookScript', () => {
  it('returns the script result', async () => {
    const { file, hash } = write('ok', `export const meta = { description: 'x' };\nexport default async function () { return { hi: 1 }; }\n`);
    const res = await runPlaybookScript({ file, hash, params: {}, meta: META, onCommand: noCommands, onLog: noLogs });
    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ hi: 1 });
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('forwards commands to onCommand verbatim and returns the reply', async () => {
    const seen: Array<{ method: string; params: any }> = [];
    const { file, hash } = write('cmd', `export const meta = { description: 'x' };
export default async function ({ supersurf }) {
  await supersurf.goto('https://example.com');
  return await supersurf.seeText('Example');
}
`);
    const res = await runPlaybookScript({
      file, hash, params: {}, meta: META, onLog: noLogs,
      onCommand: async (method, params) => {
        seen.push({ method, params });
        return method === 'seeText' ? { visible: true, text: 'Example' } : { success: true };
      },
    });
    expect(res.ok).toBe(true);
    expect(res.result).toBe(true);
    expect(seen).toEqual([
      { method: 'goto', params: { url: 'https://example.com' } },
      { method: 'seeText', params: { text: 'Example' } },
    ]);
  });

  it('passes params into the script', async () => {
    // PLAN CORRECTION: the plan passed `meta: META`, which declares no params,
    // so validateParams rejected { a, b } as unknown before anything spawned —
    // the run failed with `result: undefined` rather than reaching the script.
    // The meta has to declare what the caller sends.
    const meta: PlaybookMeta = {
      description: 'x',
      params: { a: { type: 'number', required: true }, b: { type: 'number', required: true } },
    };
    const { file, hash } = write('params', `export const meta = { description: 'x' };\nexport default async function ({ params }) { return params.a + params.b; }\n`);
    const res = await runPlaybookScript({ file, hash, params: { a: 2, b: 3 }, meta, onCommand: noCommands, onLog: noLogs });
    expect(res.ok).toBe(true);
    expect(res.result).toBe(5);
  });

  it('forwards log() calls to onLog', async () => {
    const logs: string[] = [];
    const { file, hash } = write('logs', `export const meta = { description: 'x' };\nexport default async function ({ log }) { log('step one'); return 1; }\n`);
    await runPlaybookScript({ file, hash, params: {}, meta: META, onCommand: noCommands, onLog: (m) => logs.push(m) });
    expect(logs).toContain('step one');
  });

  it('reports a thrown error with a stack', async () => {
    const { file, hash } = write('boom', `export const meta = { description: 'x' };\nexport default async function () { throw new Error('kaboom'); }\n`);
    const res = await runPlaybookScript({ file, hash, params: {}, meta: META, onCommand: noCommands, onLog: noLogs });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('kaboom');
    expect(res.stack).toContain('boom.playbook.js');
  });

  it('turns an onCommand rejection into a throw inside the script', async () => {
    const { file, hash } = write('reject', `export const meta = { description: 'x' };
export default async function ({ supersurf }) {
  try { await supersurf.click('#go'); return 'no throw'; }
  catch (e) { return 'caught: ' + e.message; }
}
`);
    const res = await runPlaybookScript({
      file, hash, params: {}, meta: META, onLog: noLogs,
      onCommand: async () => { throw new Error('Element not found: #go'); },
    });
    expect(res.result).toBe('caught: Element not found: #go');
  });

  it('kills a script that runs past the timeout', async () => {
    const { file, hash } = write('hang', `export const meta = { description: 'x' };\nexport default async function () { await new Promise(() => {}); }\n`);
    const res = await runPlaybookScript({ file, hash, params: {}, meta: META, onCommand: noCommands, onLog: noLogs, timeoutMs: 400 });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('timed out');
  });

  it('rejects invalid params before spawning anything', async () => {
    const { file, hash } = write('typed', `export const meta = { description: 'x', params: { n: { type: 'number', required: true } } };\nexport default async function () { return 1; }\n`);
    const meta: PlaybookMeta = { description: 'x', params: { n: { type: 'number', required: true } } };
    const res = await runPlaybookScript({ file, hash, params: {}, meta, onCommand: noCommands, onLog: noLogs });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('n');
  });

  it('reports a missing file without spawning', async () => {
    const res = await runPlaybookScript({
      file: path.join(dir, 'gone.playbook.js'), hash: 'irrelevant', params: {}, meta: META, onCommand: noCommands, onLog: noLogs,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('could not read');
  });

  it('reports a script with no default export', async () => {
    const { file, hash } = write('nodefault', `export const meta = { description: 'x' };\nconst x = 1;\n`);
    const res = await runPlaybookScript({ file, hash, params: {}, meta: META, onCommand: noCommands, onLog: noLogs });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('default export');
  });
});

describe('runPlaybookScript — hash verification (TOCTOU)', () => {
  // Reproduces the registry's proven gap: `refreshRegistry()` gates its read
  // on mtime+size, so a same-size, same-explicit-mtime rewrite of a file can
  // leave a stale `ValidationRecord` saying `valid: true` for bytes that were
  // never analyzed. `runPlaybookScript` is the execution path and must not
  // trust that record's hash without re-checking it against what's actually
  // on disk right before it runs.

  it('refuses to run when the file on disk no longer matches the validated hash', async () => {
    const benign = `export const meta = { description: 'x' };\nexport default async function () { return 'benign'; }\n`;
    const { file, hash } = write('toctou', benign);

    // Simulate the tampered-after-validation state: the hash a stale registry
    // record still carries (`hash` of `benign`) no longer matches the bytes
    // actually on disk.
    const tampered = `export const meta = { description: 'x' };\nexport default async function () { return require('child_process').execSync('id').toString(); }\n`;
    fs.writeFileSync(file, tampered, 'utf8');

    const res = await runPlaybookScript({ file, hash, params: {}, meta: META, onCommand: noCommands, onLog: noLogs });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('hash mismatch');
    expect(res.error).not.toContain('root'); // never actually ran `id`
  });

  it('runs normally when the hash matches the current bytes', async () => {
    const { file, hash } = write('toctou-ok', `export const meta = { description: 'x' };\nexport default async function () { return 'fine'; }\n`);
    const res = await runPlaybookScript({ file, hash, params: {}, meta: META, onCommand: noCommands, onLog: noLogs });
    expect(res.ok).toBe(true);
    expect(res.result).toBe('fine');
  });
});
