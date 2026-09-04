import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
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
  MAX_FAIL_STACK_CHARS,
  MAX_FAIL_MESSAGE_CHARS,
  MAX_LOG_LINE_CHARS,
  MAX_LOG_TOTAL_CHARS,
  MAX_RESULT_CHARS,
  MAX_COMMAND_METHOD_CHARS,
  MAX_STDOUT_LINE_CHARS,
} from '../src/security/sandbox/host';
import type { PlaybookMeta } from '../src/security/meta';
import { PlaybookCommandError } from '../src/playbooks/errors';

/**
 * `handleCommand`'s `at.method` cap and the stderr caps are only reachable
 * by a COMPROMISED child forging protocol frames — an honest playbook body
 * runs inside the `node:vm` context in `context.ts`, which has no `process`
 * (so it cannot write real stderr) and no way to emit a `cmd` frame with any
 * `method` other than one of the 52 declared `supersurf.*` names (see the
 * doc on `MAX_COMMAND_METHOD_CHARS` in `host.ts`). Proving those two caps
 * still requires a REAL spawned child and a REAL pipe — the task's own
 * constraint — so this substitutes which script gets spawned, not the pipe
 * itself: `spawnOverride` set, `runPlaybookScript`'s own `resolveChildEntry`
 * / permission-flag / sandboxing-check logic all still run unchanged, and
 * only the final `spawn(...)` call's command+argv are swapped for a raw
 * fixture script that speaks the NDJSON protocol directly. `vi.spyOn` cannot
 * do this — `child_process`'s compiled CommonJS export is a frozen ESM
 * namespace property vitest cannot redefine — so this uses `vi.mock`, which
 * substitutes the whole module at resolution time instead.
 */
let spawnOverride: { command: string; argv: string[] } | null = null;
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      if (spawnOverride) return actual.spawn(spawnOverride.command, spawnOverride.argv, args[2] as any);
      return (actual.spawn as any)(...args);
    },
  };
});

let dir: string;
beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-host-')); });
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });
afterEach(() => { spawnOverride = null; });

/** Writes a raw NDJSON-protocol-speaking fixture script (NOT a playbook —
 *  no sandboxing, no vm context) and points `spawnOverride` at it. Used only
 *  by the "compromised child" tests below, which forge protocol frames an
 *  honest playbook cannot reach. */
function useFixtureChild(name: string, script: string): void {
  const file = path.join(dir, `${name}.fixture.js`);
  fs.writeFileSync(file, script, 'utf8');
  spawnOverride = { command: process.execPath, argv: [file] };
}

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

describe('failure typing across the sandbox pipe', () => {
  it('types a script own throw as ScriptAssertion and keeps the stack', async () => {
    const { file, hash } = write(
      'type-assert',
      'export default async function () { throw new Error("confirmSend must be true"); }',
    );
    const res = await runPlaybookScript({ file, hash, params: {}, meta: META, onCommand: noCommands, onLog: noLogs });
    expect(res.ok).toBe(false);
    expect(res.type).toBe('ScriptAssertion');
    expect(res.error).toContain('confirmSend must be true');
    expect(res.stack).toBeTruthy();
  });

  it('caps an oversized stack and message at the pipe boundary', async () => {
    // Every field of a `fail` frame is child-controlled: `wrap()` in context.ts
    // rebuilds a thrown error as a bare vm-realm Error, so nothing about the
    // shape below is verifiable host-side. An uncapped `stack` reopens the
    // exact 766 KB bug this branch exists to close, through a different field —
    // it is persisted verbatim into the run sidecar and pushed into the
    // agent-facing MCP response.
    // Sized well past the fail-frame caps (MAX_FAIL_STACK_CHARS 4000,
    // MAX_FAIL_MESSAGE_CHARS 1000) but comfortably under MAX_STDOUT_LINE_CHARS
    // (Fix 4's raw-line ceiling on the wire, 200000) — this test is about the
    // FRAME-FIELD caps below, not Fix 4's separate protocol-violation guard on
    // an unparsed line.
    const { file, hash } = write(
      'oversized',
      `export default async function () {
  const e = new Error('M'.repeat(30000));
  e.stack = 'Z'.repeat(100000);
  throw e;
}`,
    );
    const res = await runPlaybookScript({ file, hash, params: {}, meta: META, onCommand: noCommands, onLog: noLogs });
    expect(res.ok).toBe(false);
    expect(res.stack!.length).toBeLessThanOrEqual(MAX_FAIL_STACK_CHARS + 32);
    expect(res.stack).toContain('[truncated]');
    expect(res.error!.length).toBeLessThanOrEqual(MAX_FAIL_MESSAGE_CHARS + 32);
    expect(res.error).toContain('[truncated]');
  });

  it('propagates a typed tool failure through the pipe instead of flattening it', async () => {
    const { file, hash } = write(
      'type-tool',
      'export default async function ({ supersurf }) { await supersurf.click("#gone"); }',
    );
    const res = await runPlaybookScript({
      file, hash, params: {}, meta: META, onLog: noLogs,
      onCommand: async () => {
        throw new PlaybookCommandError('Element not found: #gone', 'SelectorMiss', { selector: '#gone' });
      },
    });
    expect(res.ok).toBe(false);
    expect(res.type).toBe('SelectorMiss');
    expect(res.payload).toMatchObject({ selector: '#gone' });
  });

  it('types the wall-clock kill as Timeout', async () => {
    const { file, hash } = write('type-timeout', 'export default async function () { await new Promise(() => {}); }');
    const res = await runPlaybookScript({
      file, hash, params: {}, meta: META, onCommand: noCommands, onLog: noLogs, timeoutMs: 400,
    });
    expect(res.ok).toBe(false);
    expect(res.type).toBe('Timeout');
  });

  it('types a hash mismatch as Refused', async () => {
    const { file } = write('type-hash', 'export default async function () { return 1; }');
    const res = await runPlaybookScript({
      file, hash: 'wrong', params: {}, meta: META, onCommand: noCommands, onLog: noLogs,
    });
    expect(res.ok).toBe(false);
    expect(res.type).toBe('Refused');
  });

  it('stays ScriptAssertion when the script catches a tool failure and throws a different message', async () => {
    const { file, hash } = write(
      'catch-rethrow-different',
      `export default async function ({ supersurf }) {
  try { await supersurf.click("#gone"); }
  catch (e) { throw new Error("my own assertion failed"); }
}`,
    );
    const res = await runPlaybookScript({
      file, hash, params: {}, meta: META, onLog: noLogs,
      onCommand: async () => {
        throw new PlaybookCommandError('Element not found: #gone', 'SelectorMiss', { selector: '#gone' });
      },
    });
    expect(res.ok).toBe(false);
    expect(res.type).toBe('ScriptAssertion');
    expect(res.error).toContain('my own assertion failed');
  });

  it('returns ok with no type when the script catches a tool failure and continues', async () => {
    const { file, hash } = write(
      'catch-continue',
      `export default async function ({ supersurf }) {
  try { await supersurf.click("#gone"); } catch (e) { /* swallow */ }
  return 'fine';
}`,
    );
    const res = await runPlaybookScript({
      file, hash, params: {}, meta: META, onLog: noLogs,
      onCommand: async () => {
        throw new PlaybookCommandError('Element not found: #gone', 'SelectorMiss', { selector: '#gone' });
      },
    });
    expect(res.ok).toBe(true);
    expect(res.type).toBeUndefined();
    expect(res.result).toBe('fine');
  });

  it('uses the second failure type when the first is caught and a second is uncaught', async () => {
    const { file, hash } = write(
      'two-failures',
      `export default async function ({ supersurf }) {
  try { await supersurf.click("#gone"); } catch (e) { /* swallow the first */ }
  await supersurf.click("#also-gone");
}`,
    );
    let calls = 0;
    const res = await runPlaybookScript({
      file, hash, params: {}, meta: META, onLog: noLogs,
      onCommand: async () => {
        calls++;
        if (calls === 1) throw new PlaybookCommandError('Element not found: #gone', 'SelectorMiss', { selector: '#gone' });
        throw new PlaybookCommandError('Extension not connected', 'HarnessUnavailable', { component: 'extension' });
      },
    });
    expect(res.ok).toBe(false);
    expect(res.type).toBe('HarnessUnavailable');
    expect(res.payload).toMatchObject({ component: 'extension' });
  });

  it('does not let a script forge its own failure type or payload', async () => {
    // `wrap()` in context.ts only strips properties on the host-method-return
    // path. A script that constructs and throws its OWN error never crosses
    // that boundary, so any property it sets — including a forged
    // __ssType/__ssPayload — reaches child.ts's catch intact. The host must
    // still refuse to adopt it: nothing that isn't the host's own correlated
    // record may become the result's type/payload.
    const { file, hash } = write(
      'forge',
      `export default async function () {
  const e = new Error('boom');
  e.__ssType = 'HarnessUnavailable';
  e.__ssPayload = { forged: true };
  throw e;
}`,
    );
    const res = await runPlaybookScript({ file, hash, params: {}, meta: META, onCommand: noCommands, onLog: noLogs });
    expect(res.ok).toBe(false);
    expect(res.type).toBe('ScriptAssertion');
    expect(res.payload).toBeUndefined();
  });
});

describe('log and result caps at the sandbox pipe', () => {
  // Same threat model as the fail-frame caps above: `log()` and a script's
  // return value are just as child-controlled as `stack`/`message`, and land
  // in the same two sinks (`runs.ts`'s sidecar, `tools/playbooks.ts`'s
  // agent-facing MCP response) if left uncapped.

  it('caps a single oversized log line', async () => {
    const { file, hash } = write(
      'log-oversized',
      `export default async function ({ log }) { log('Z'.repeat(50000)); return 1; }`,
    );
    const logs: string[] = [];
    const res = await runPlaybookScript({
      file, hash, params: {}, meta: META, onCommand: noCommands, onLog: (m) => logs.push(m),
    });
    expect(res.ok).toBe(true);
    expect(logs.length).toBe(1);
    // If the per-line cap were removed, this line would be exactly 50000 chars
    // — well over the cap plus the "…[truncated]" marker's own length.
    expect(logs[0].length).toBeLessThanOrEqual(MAX_LOG_LINE_CHARS + 32);
    expect(logs[0]).toContain('[truncated]');
  });

  it('caps the total log budget across many small lines, with a visible drop notice', async () => {
    // 1000 lines of 50 chars each = 50000 chars total, well under the 2000-char
    // per-line cap individually but over MAX_LOG_TOTAL_CHARS (20000) in
    // aggregate — the exact "million short lines" shape the per-line cap alone
    // cannot stop.
    const { file, hash } = write(
      'log-flood',
      `export default async function ({ log }) {
  for (let i = 0; i < 1000; i++) log('x'.repeat(50));
  return 'done';
}`,
    );
    const logs: string[] = [];
    const res = await runPlaybookScript({
      file, hash, params: {}, meta: META, onCommand: noCommands, onLog: (m) => logs.push(m),
    });
    expect(res.ok).toBe(true);
    // If the total-budget check were removed, all 1000 calls would pass
    // through (each is well under the per-line cap) and this would be 1000.
    expect(logs.length).toBeLessThan(1000);
    expect(logs[logs.length - 1]).toContain('further log output dropped');
    const totalRealLogChars = logs.slice(0, -1).reduce((sum, l) => sum + l.length, 0);
    expect(totalRealLogChars).toBeLessThanOrEqual(MAX_LOG_TOTAL_CHARS + 50);
  });

  it('caps an oversized done-frame result with a visible truncation marker', async () => {
    // 150000 chars: comfortably past MAX_RESULT_CHARS (100000, so capResult's
    // truncation still fires) and comfortably under MAX_STDOUT_LINE_CHARS
    // (200000, Fix 4's raw-line ceiling on the wire), so this exercises
    // capResult's truncation and not Fix 4's separate protocol-violation
    // guard on the unparsed line.
    const oversized = 150000;
    const { file, hash } = write(
      'result-oversized',
      `export default async function () { return 'Z'.repeat(${oversized}); }`,
    );
    const res = await runPlaybookScript({ file, hash, params: {}, meta: META, onCommand: noCommands, onLog: noLogs });
    expect(res.ok).toBe(true);
    // If capResult were removed, res.result would be the raw 150000-char
    // string, not an object — this shape check alone would fail.
    expect(typeof res.result).toBe('object');
    const capped = res.result as any;
    expect(capped.__truncated).toBe(true);
    expect(typeof capped.preview).toBe('string');
    expect(capped.preview.length).toBeLessThan(oversized);
    // The whole point: an agent must be able to tell this was cut, not assume
    // it received the complete 150000-char string.
    expect(JSON.stringify(res.result).length).toBeLessThan(MAX_RESULT_CHARS);
  });

  it('leaves an ordinary, well-under-cap result untouched', async () => {
    const { file, hash } = write(
      'result-normal',
      `export default async function () { return { a: 1, b: 'fine' }; }`,
    );
    const res = await runPlaybookScript({ file, hash, params: {}, meta: META, onCommand: noCommands, onLog: noLogs });
    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ a: 1, b: 'fine' });
  });
});

describe('stderr and forged-command-method caps (compromised child)', () => {
  // Everything below is reachable ONLY by a child that writes real bytes to
  // fd 2 or forges a `cmd` frame with an arbitrary `method` — an honest
  // playbook, running inside the `node:vm` context, can do neither (no
  // `process`, and `supersurf.*` only ever emits one of 52 declared short
  // method names). These tests substitute the spawned SCRIPT via
  // `useFixtureChild`, never the pipe — the child is a real OS process
  // talking the real NDJSON protocol over real pipes the whole time.

  it('caps a single oversized stderr chunk, charged against the shared log budget', async () => {
    const { file, hash } = write('at-stderr-single', `export default async function () { return 1; }`);
    useFixtureChild(
      'stderr-single',
      `process.stdin.resume();
process.stderr.write('Z'.repeat(10000));
// Wait past the stderr 'data' event before sending 'done' — the two are
// separate pipes with no ordering guarantee between them, and 'done' ends
// the run the moment the host reads it.
setTimeout(() => {
  process.stdout.write(JSON.stringify({ t: 'done', result: 1 }) + '\\n');
  setTimeout(() => process.exit(0), 50);
}, 30);`,
    );
    const logs: string[] = [];
    const res = await runPlaybookScript({
      file, hash, params: {}, meta: META, onCommand: noCommands, onLog: (m) => logs.push(m),
    });
    expect(res.ok).toBe(true);
    // If the per-chunk cap were removed, this would be one 10000-char entry.
    expect(logs.length).toBe(1);
    expect(logs[0].length).toBeLessThanOrEqual(MAX_LOG_LINE_CHARS + 32);
    expect(logs[0]).toContain('[truncated]');
  });

  it('shares the log budget with stdout log() calls — spending it on stdout starves stderr', async () => {
    // 9 stdout log frames of exactly MAX_LOG_LINE_CHARS chars = 18000 chars,
    // leaving 2000 of the 20000-char shared budget. A subsequent 5000-char
    // stderr chunk caps to 2012 chars ("…[truncated]" included) — over what's
    // left — so it must be dropped entirely, not partially forwarded.
    const { file, hash } = write('at-stderr-shared-fwd', `export default async function () { return 1; }`);
    useFixtureChild(
      'stderr-shared-fwd',
      `process.stdin.resume();
function emit(f) { process.stdout.write(JSON.stringify(f) + '\\n'); }
for (let i = 0; i < 9; i++) emit({ t: 'log', message: 'Y'.repeat(${MAX_LOG_LINE_CHARS}) });
process.stderr.write('X'.repeat(5000));
// Wait past the stderr 'data' event before sending 'done' — stdout and
// stderr are separate pipes with no ordering guarantee between them.
setTimeout(() => {
  emit({ t: 'done', result: 1 });
  setTimeout(() => process.exit(0), 50);
}, 30);`,
    );
    const logs: string[] = [];
    const res = await runPlaybookScript({
      file, hash, params: {}, meta: META, onCommand: noCommands, onLog: (m) => logs.push(m),
    });
    expect(res.ok).toBe(true);
    // If stderr had its OWN separate budget instead of sharing this one, the
    // stderr chunk would still get through and this would be 10, with the
    // 10th entry containing raw "X" content instead of a drop notice.
    expect(logs.length).toBe(10);
    for (let i = 0; i < 9; i++) expect(logs[i].length).toBe(MAX_LOG_LINE_CHARS);
    expect(logs[9]).toContain('further log output dropped');
    expect(logs.some((l) => l.includes('X'))).toBe(false);
  });

  it('shares the log budget the other way — spending it on stderr starves stdout log()', async () => {
    // Ack-driven, not timing-driven: this used to space 11 stderr writes 5ms
    // apart on the claim that "a few ms apart reliably yields one 'data'
    // event per write." That claim is FALSE under load — a REPRODUCED flake:
    // the parent event loop blocks in ~20ms slices under load, so the writes
    // coalesce into 3-4 'data' events instead of 11, and this test's exact
    // `logs.length` assertions broke. The fixture below writes one stderr
    // chunk, sends a `cmd` frame, and writes the NEXT chunk only once the
    // matching `res` comes back — a real round trip through the host, so the
    // writes can never coalesce regardless of how the OS schedules the
    // parent. No timing constant governs the write cadence anywhere below.
    // The first 10 exactly fill the 20000-char budget; the 11th trips it.
    // A stdout log() call sent AFTER must then be dropped too.
    const { file, hash } = write('at-stderr-shared-rev', `export default async function () { return 1; }`);
    useFixtureChild(
      'stderr-shared-rev',
      `function emit(f) { process.stdout.write(JSON.stringify(f) + '\\n'); }
let buf = '';
let i = 0;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let idx;
  while ((idx = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let frame;
    try { frame = JSON.parse(line); } catch (e) { continue; }
    if (frame.t === 'res') stepErr();
  }
});
function stepErr() {
  if (i >= 11) { afterErr(); return; }
  i++;
  process.stderr.write('X'.repeat(${MAX_LOG_LINE_CHARS}));
  emit({ t: 'cmd', id: i, method: 'sync', params: {} });
}
function afterErr() {
  emit({ t: 'log', message: 'late log after budget exhausted' });
  emit({ t: 'done', result: 1 });
  setTimeout(() => process.exit(0), 50);
}
stepErr();`,
    );
    const logs: string[] = [];
    const res = await runPlaybookScript({
      file, hash, params: {}, meta: META, onLog: (m) => logs.push(m),
      onCommand: async (method) => {
        if (method !== 'sync') throw new Error(`unexpected command: ${method}`);
        return {};
      },
    });
    expect(res.ok).toBe(true);
    // If a stdout log() call ignored the budget stderr already spent, the
    // late log() call would get through as a 12th entry containing its text.
    expect(logs.length).toBe(11);
    expect(logs[10]).toContain('further log output dropped');
    expect(logs.some((l) => l.includes('late log'))).toBe(false);
  });

  it('caps the stderr tail folded into the exit-handler HarnessUnavailable message', async () => {
    // 3 separate ~1500-char stderr lines (each under the per-chunk cap, so
    // Finding 1's per-chunk cap never fires) accumulate to ~4500 chars, then
    // the child exits without a done/fail frame. The tail ring (Fix 2) is
    // itself bounded to MAX_FAIL_MESSAGE_CHARS on every append, so — unlike
    // before Fix 2, when an unbounded accumulator relied ENTIRELY on the exit
    // handler's own capText call to cut it down — the assembled tail here may
    // already be within budget by the time it reaches that call. What must
    // still hold is the OUTCOME the exit handler's cap exists to guarantee:
    // the final message never exceeds the cap, belt-and-braces or not.
    const { file, hash } = write('at-stderr-exit-tail', `export default async function () { return 1; }`);
    useFixtureChild(
      'stderr-exit-tail',
      `process.stdin.resume();
let i = 0;
function stepErr() {
  if (i++ >= 3) { setTimeout(() => process.exit(7), 50); return; }
  process.stderr.write('E'.repeat(1500) + '\\n');
  setTimeout(stepErr, 5);
}
stepErr();`,
    );
    const res = await runPlaybookScript({ file, hash, params: {}, meta: META, onCommand: noCommands, onLog: noLogs });
    expect(res.ok).toBe(false);
    expect(res.type).toBe('HarnessUnavailable');
    // If neither the tail ring nor the exit handler's own cap bounded this,
    // the message would carry the full ~4500-char accumulated stderr tail
    // verbatim into a persisted, agent-facing error message.
    expect(res.error!.length).toBeLessThanOrEqual(MAX_FAIL_MESSAGE_CHARS + 150);
    expect(res.error).toContain('E'); // the tail did carry real stderr content
  });

  it('reports the NEWEST stderr in the exit tail, not stale data frozen when the shared log budget tripped', async () => {
    // This is Fix 2's regression lock: before it, `stderr` only grew INSIDE
    // the budget-guarded path, so once `logTruncated` flipped, the exit
    // handler's tail was built from a string that had stopped updating 20 KB
    // ago — a chatty child that then died reported ancient noise instead of
    // its fatal message. Write well past MAX_LOG_TOTAL_CHARS of filler stderr
    // (tripping the shared budget), THEN a distinctive fatal line, then exit
    // non-zero with no done/fail frame. The tail ring updates on every chunk
    // regardless of the budget, so the fatal line must survive into the
    // error message even though the forwarding budget was long since spent.
    const { file, hash } = write('at-stderr-exit-tail-fresh', `export default async function () { return 1; }`);
    useFixtureChild(
      'stderr-exit-tail-fresh',
      `process.stdin.resume();
let i = 0;
function stepErr() {
  if (i++ >= 15) {
    process.stderr.write('FATAL_MARKER_XYZ\\n');
    setTimeout(() => process.exit(3), 50);
    return;
  }
  process.stderr.write('E'.repeat(${MAX_LOG_LINE_CHARS}) + '\\n');
  setTimeout(stepErr, 5);
}
stepErr();`,
    );
    const res = await runPlaybookScript({ file, hash, params: {}, meta: META, onCommand: noCommands, onLog: noLogs });
    expect(res.ok).toBe(false);
    expect(res.type).toBe('HarnessUnavailable');
    expect(res.error).toContain('FATAL_MARKER_XYZ');
    expect(res.error!.length).toBeLessThanOrEqual(MAX_FAIL_MESSAGE_CHARS + 150);
  });

  it('caps a forged oversized cmd.method recorded against a classified command failure', async () => {
    // No honest playbook can send a `cmd` frame with a `method` other than
    // one of the 52 declared short `supersurf.*` names — this forges one
    // directly at the protocol level to prove `at.method` (Finding 2) is
    // capped without touching the VERBATIM `method` forwarded to onCommand.
    // Sized well under MAX_STDOUT_LINE_CHARS (Fix 4's raw-line ceiling) so
    // this test exercises the Addendum-A verbatim-forward exception, not Fix
    // 4's separate protocol-violation guard on an unparsed line — a cmd
    // frame's method/params are the ONE thing that boundary still lets
    // through unbounded, up to the wire itself.
    const forgedMethodLength = MAX_STDOUT_LINE_CHARS - 50000;
    const { file, hash } = write('at-method-forged', `export default async function () { return 1; }`);
    useFixtureChild(
      'method-forged',
      `let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let idx;
  while ((idx = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let frame;
    try { frame = JSON.parse(line); } catch (e) { continue; }
    if (frame.t === 'init') {
      process.stdout.write(JSON.stringify({ t: 'cmd', id: 1, method: 'Z'.repeat(${forgedMethodLength}), params: {} }) + '\\n');
    } else if (frame.t === 'res') {
      process.stdout.write(JSON.stringify({ t: 'fail', message: frame.error }) + '\\n');
      setTimeout(() => process.exit(0), 50);
    }
  }
});`,
    );
    let forwardedMethodLength = -1;
    const res = await runPlaybookScript({
      file, hash, params: {}, meta: META, onLog: noLogs,
      onCommand: async (method) => {
        forwardedMethodLength = method.length;
        throw new PlaybookCommandError('forged method test', 'SelectorMiss', { selector: 'x' });
      },
    });
    // The forward to onCommand must stay VERBATIM (spec Addendum A) — only
    // the host's OWN copy in `at.method` gets capped.
    expect(forwardedMethodLength).toBe(forgedMethodLength);
    expect(res.ok).toBe(false);
    expect(res.type).toBe('SelectorMiss');
    const at = (res.payload as any)?.at;
    expect(at).toBeTruthy();
    // If `at.method`'s cap were removed, this would be `forgedMethodLength` chars long.
    expect(at.method.length).toBeLessThanOrEqual(MAX_COMMAND_METHOD_CHARS + 32);
    expect(at.method).toContain('[truncated]');
    expect(at.step).toBe(1);
  });
});

describe('stdout line-buffer ceiling (compromised child)', () => {
  // No honest playbook can hold a stdout write open with no '\n' forever —
  // the NDJSON protocol is entirely `child.ts`'s to speak, and it always
  // terminates a frame with a newline. Only a compromised child writing raw
  // bytes directly to fd 1 can trigger this. `useFixtureChild` is what makes
  // that reachable in a test — see the block comment above.

  it('fails an over-long unterminated stdout line as a protocol violation', async () => {
    const { file, hash } = write('at-stdout-overlong', `export default async function () { return 1; }`);
    useFixtureChild(
      'stdout-overlong',
      `process.stdin.resume();
process.stdout.write('Z'.repeat(${MAX_STDOUT_LINE_CHARS} + 1000));`,
    );
    const res = await runPlaybookScript({ file, hash, params: {}, meta: META, onCommand: noCommands, onLog: noLogs });
    expect(res.ok).toBe(false);
    expect(res.type).toBe('HarnessUnavailable');
    expect(res.error).toContain('over-long');
  });

  it('never trips on a legitimate maximum-size result frame plus its JSON envelope', async () => {
    // A well-behaved script returning right at MAX_RESULT_CHARS produces a
    // `done` line whose JSON envelope adds a little overhead on top of the
    // result's own serialized length. MAX_STDOUT_LINE_CHARS is 2x
    // MAX_RESULT_CHARS specifically so this never false-positives.
    const { file, hash } = write(
      'at-stdout-maxresult',
      `export default async function () { return 'Z'.repeat(${MAX_RESULT_CHARS - 100}); }`,
    );
    const res = await runPlaybookScript({ file, hash, params: {}, meta: META, onCommand: noCommands, onLog: noLogs });
    expect(res.ok).toBe(true);
    expect(typeof res.result).toBe('string');
    expect((res.result as string).length).toBe(MAX_RESULT_CHARS - 100);
  });
});
