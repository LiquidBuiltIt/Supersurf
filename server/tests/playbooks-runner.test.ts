import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { setPlaybooksDirForTests } from '../src/playbooks/paths';
import { readRunRecords } from '../src/playbooks/runs';
import { validateParams, runPlaybook, defaultEnableExperiments, type RunnerBackend } from '../src/playbooks/runner';
import { getSession } from '../src/experimental/mouse-humanization/index';
import type { ValidationRecord } from '../src/security/validate';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-run-'));
  setPlaybooksDirForTests(dir);
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function record(over: Partial<ValidationRecord> = {}): ValidationRecord {
  return {
    file: path.join(dir, 'post_tweet.playbook.js'),
    name: 'post_tweet',
    hash: 'h',
    valid: true,
    meta: { description: 'posts a tweet', params: { text: { type: 'string', required: true } } },
    signature: 'post_tweet({ text })',
    validatedAt: Date.now(),
    ...over,
  };
}

/**
 * A record backed by a REAL playbook file, so `runPlaybook` can use its default
 * `runScript` and spawn an actual sandbox child. `runPlaybookScript` re-hashes
 * the bytes before running them, so the hash has to be the file's own.
 */
function realRecord(source: string, over: Partial<ValidationRecord> = {}): ValidationRecord {
  const file = path.join(dir, 'post_tweet.playbook.js');
  fs.writeFileSync(file, source, 'utf8');
  return record({ file, hash: crypto.createHash('sha256').update(source, 'utf8').digest('hex'), ...over });
}

/** Records every callTool the runner makes, in order. */
function fakeBackend(over: Partial<Record<string, any>> = {}): { backend: RunnerBackend; calls: any[] } {
  const calls: any[] = [];
  const backend: RunnerBackend = {
    async callTool(name: string, a: any) {
      calls.push({ name, args: a });
      if (name === 'connect') return { success: true };
      if (name === 'browser_tabs' && a.action === 'new') {
        return { attachedTab: { id: 1, index: 0, title: 'Untitled', url: 'about:blank', groupId: -1 }, stealthMode: false };
      }
      if (name === 'browser_snapshot') return { success: true, snapshot: '<page snapshot>' };
      return over[name] ?? { success: true };
    },
  };
  return { backend, calls };
}

describe('validateParams', () => {
  it('accepts a well-formed argument set', () => {
    expect(validateParams(record().meta!, { text: 'hi' })).toBeNull();
  });

  it('reports a missing required param', () => {
    expect(validateParams(record().meta!, {})).toContain('text');
  });

  it('reports a type mismatch', () => {
    expect(validateParams(record().meta!, { text: 42 })).toContain('expected string');
  });

  it('reports an unknown param rather than silently dropping it', () => {
    expect(validateParams(record().meta!, { text: 'hi', nope: 1 })).toContain('nope');
  });

  it('accepts anything when meta declares no params', () => {
    expect(validateParams({ description: 'x' }, {})).toBeNull();
  });
});

describe('runPlaybook', () => {
  it('connects with its own client_id, opens its own tab, closes it, disconnects', async () => {
    const { backend, calls } = fakeBackend();
    await runPlaybook({
      record: record(), params: { text: 'hi' }, caller: 'agent',
      createBackend: () => backend,
      runScript: async () => ({ ok: true, result: 'done', durationMs: 5 }),
    });
    const names = calls.map(c => c.name);
    expect(names[0]).toBe('connect');
    expect(String(calls[0].args.client_id)).toMatch(/^playbook-post_tweet-/);
    expect(names).toContain('browser_tabs');
    expect(calls.filter(c => c.name === 'browser_tabs' && c.args.action === 'new').length).toBe(1);
    expect(calls.filter(c => c.name === 'browser_tabs' && c.args.action === 'close').length).toBe(1);
    expect(names[names.length - 1]).toBe('disconnect');
  });

  it('passes the profile through to connect', async () => {
    const { backend, calls } = fakeBackend();
    await runPlaybook({
      record: record(), params: { text: 'hi' }, caller: 'cli', profile: 'reselling-fb',
      createBackend: () => backend,
      runScript: async () => ({ ok: true, durationMs: 1 }),
    });
    expect(calls[0].args.profile).toBe('reselling-fb');
  });

  it('routes an onCommand call through the command map to callTool', async () => {
    const { backend, calls } = fakeBackend();
    await runPlaybook({
      record: record(), params: { text: 'hi' }, caller: 'agent',
      createBackend: () => backend,
      runScript: async (opts) => {
        await opts.onCommand('click', { selector: '#go' });
        return { ok: true, durationMs: 1 };
      },
    });
    const click = calls.find(c => c.name === 'browser_interact');
    expect(click.args).toEqual({ actions: [{ type: 'click', selector: '#go' }] });
  });

  it('turns a rawResult failure into a thrown error for the child', async () => {
    const { backend } = fakeBackend({ browser_interact: { success: false, error: 'Element not found' } });
    let thrown: string | null = null;
    await runPlaybook({
      record: record(), params: { text: 'hi' }, caller: 'agent',
      createBackend: () => backend,
      runScript: async (opts) => {
        try { await opts.onCommand('click', { selector: '#go' }); } catch (e: any) { thrown = e.message; }
        return { ok: true, durationMs: 1 };
      },
    });
    expect(thrown).toBe('Element not found');
  });

  // Regression lock. The REAL `browser_interact` failure envelope carries its
  // diagnostic in `actions`, not `error`/`message`. Verified live against
  // Chromium: `{ success: false, actions: ['✗ click: Element not found: `#x`'] }`.
  // Reading only `error`/`message` reported "command failed" and lost the reason.
  it('surfaces the REAL browser_interact failure envelope, not "command failed"', async () => {
    const { backend } = fakeBackend({
      browser_interact: { success: false, actions: ['✗ click: Element not found: `#go`'] },
    });
    let thrown: string | null = null;
    await runPlaybook({
      record: record(), params: { text: 'hi' }, caller: 'agent',
      createBackend: () => backend,
      runScript: async (opts) => {
        try { await opts.onCommand('click', { selector: '#go' }); } catch (e: any) { thrown = e.message; }
        return { ok: true, durationMs: 1 };
      },
    });
    expect(thrown).toBe('✗ click: Element not found: `#go`');
    expect(thrown).not.toBe('command failed');
  });

  it('does not capture evidence on success', async () => {
    const { backend, calls } = fakeBackend();
    const out = await runPlaybook({
      record: record(), params: { text: 'hi' }, caller: 'agent',
      createBackend: () => backend,
      runScript: async () => ({ ok: true, durationMs: 1 }),
    });
    expect(out.evidence).toBeUndefined();
    expect(calls.some(c => c.name === 'browser_snapshot')).toBe(false);
  });

  it('enables every experiment for the run when meta.experiments is true', async () => {
    const { backend, calls } = fakeBackend();
    const enabled: string[] = [];
    await runPlaybook({
      record: record({ meta: { description: 'd', experiments: true } as any }),
      params: {}, caller: 'agent',
      createBackend: () => backend,
      enableExperiments: (clientId: string) => enabled.push(clientId),
      runScript: async () => ({ ok: true, durationMs: 1 }),
    });
    expect(enabled.length).toBe(1);
    expect(enabled[0]).toMatch(/^playbook-post_tweet-/);
    // Activation happens after connect, never before — Plan 1 scopes the
    // registry per session, so the session must exist first.
    expect(calls[0].name).toBe('connect');
    expect(readRunRecords('post_tweet')[0].experiments).toBe(true);
  });

  it('creates the mouse-humanization session itself, because connect already ran', async () => {
    // Plan 1's onConnect gates initHumanization behind isEnabled(...) evaluated
    // DURING connect. We enable after connect, so without the explicit call the
    // session never exists and every mouse move degrades to a CDP teleport.
    const { backend } = fakeBackend();
    let seen = '';
    await runPlaybook({
      record: record({ meta: { description: 'd', experiments: true } as any }),
      params: {}, caller: 'agent',
      createBackend: () => backend,
      enableExperiments: (clientId: string) => { seen = clientId; defaultEnableExperiments(clientId); },
      runScript: async () => ({ ok: true, durationMs: 1 }),
    });
    expect(getSession(seen)).toBeDefined();
  });

  it('does not create a humanization session for an ordinary run', async () => {
    const { backend } = fakeBackend();
    let seen = '';
    await runPlaybook({
      record: record(), params: { text: 'hi' }, caller: 'agent',
      createBackend: () => backend,
      enableExperiments: (clientId: string) => { seen = clientId; },
      runScript: async () => ({ ok: true, durationMs: 1 }),
    });
    expect(seen).toBe('');
  });

  it('leaves experiments alone by default and records that it did', async () => {
    const { backend } = fakeBackend();
    let touched = false;
    await runPlaybook({
      record: record(), params: { text: 'hi' }, caller: 'agent',
      createBackend: () => backend,
      enableExperiments: () => { touched = true; },
      runScript: async () => ({ ok: true, durationMs: 1 }),
    });
    expect(touched).toBe(false);
    expect(readRunRecords('post_tweet')[0].experiments).toBe(false);
  });

  it('does not activate experiments when connect fails', async () => {
    let touched = false;
    const backend: RunnerBackend = {
      async callTool(name: string) {
        if (name === 'connect') return { success: false, message: 'daemon unreachable' };
        return { success: true };
      },
    };
    await runPlaybook({
      record: record({ meta: { description: 'd', experiments: true } as any }),
      params: {}, caller: 'agent',
      createBackend: () => backend,
      enableExperiments: () => { touched = true; },
      runScript: async () => ({ ok: true, durationMs: 1 }),
    });
    expect(touched).toBe(false);
  });

  it('appends a run record with the caller and the params', async () => {
    const { backend } = fakeBackend();
    await runPlaybook({
      record: record(), params: { text: 'hi' }, caller: 'cli', profile: 'dev',
      createBackend: () => backend,
      runScript: async () => ({ ok: true, durationMs: 12 }),
    });
    const recs = readRunRecords('post_tweet');
    expect(recs.length).toBe(1);
    expect(recs[0]).toMatchObject({ ok: true, caller: 'cli', profile: 'dev', params: { text: 'hi' } });
  });

  it('closes the tab and disconnects even when connect succeeds but the script throws', async () => {
    const { backend, calls } = fakeBackend();
    const out = await runPlaybook({
      record: record(), params: { text: 'hi' }, caller: 'agent',
      createBackend: () => backend,
      runScript: async () => { throw new Error('host exploded'); },
    });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('host exploded');
    expect(calls.map(c => c.name)).toContain('disconnect');
  });

  it('fails fast without opening a tab when connect fails', async () => {
    const calls: any[] = [];
    const backend: RunnerBackend = {
      async callTool(name: string, a: any) {
        calls.push({ name, args: a });
        if (name === 'connect') return { success: false, message: 'daemon unreachable' };
        return { success: true };
      },
    };
    const out = await runPlaybook({
      record: record(), params: { text: 'hi' }, caller: 'agent',
      createBackend: () => backend,
      runScript: async () => ({ ok: true, durationMs: 1 }),
    });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('daemon unreachable');
    expect(calls.some(c => c.name === 'browser_tabs')).toBe(false);
  });

  it('fails without closing any tab when the tab open itself fails, leaving the caller\'s tab alone', async () => {
    const calls: any[] = [];
    const backend: RunnerBackend = {
      async callTool(name: string, a: any) {
        calls.push({ name, args: a });
        if (name === 'connect') return { success: true };
        if (name === 'browser_tabs' && a.action === 'new') return { success: false, error: 'No such tab' };
        return { success: true };
      },
    };
    const out = await runPlaybook({
      record: record(), params: { text: 'hi' }, caller: 'agent',
      createBackend: () => backend,
      runScript: async () => ({ ok: true, durationMs: 1 }),
    });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('No such tab');
    expect(calls.some(c => c.name === 'browser_tabs' && c.args.action === 'close')).toBe(false);
  });

  it('disconnects instead of leaking the session when the tab open throws', async () => {
    const calls: any[] = [];
    const backend: RunnerBackend = {
      async callTool(name: string, a: any) {
        calls.push({ name, args: a });
        if (name === 'connect') return { success: true };
        if (name === 'browser_tabs' && a.action === 'new') throw new Error('transport closed');
        return { success: true };
      },
    };
    const out = await runPlaybook({
      record: record(), params: { text: 'hi' }, caller: 'agent',
      createBackend: () => backend,
      runScript: async () => ({ ok: true, durationMs: 1 }),
    });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('transport closed');
    expect(calls.some(c => c.name === 'browser_tabs' && c.args.action === 'close')).toBe(false);
    expect(calls.some(c => c.name === 'disconnect')).toBe(true);
  });

  it('refuses a record with no meta', async () => {
    const { backend } = fakeBackend();
    const out = await runPlaybook({
      record: record({ valid: false, meta: undefined, error: 'blocked API: require' }),
      params: {}, caller: 'agent',
      createBackend: () => backend,
      runScript: async () => ({ ok: true, durationMs: 1 }),
    });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('blocked API: require');
  });

  it('collects the script\'s log lines', async () => {
    const { backend } = fakeBackend();
    const out = await runPlaybook({
      record: record(), params: { text: 'hi' }, caller: 'agent',
      createBackend: () => backend,
      runScript: async (opts) => { opts.onLog('step 1'); opts.onLog('step 2'); return { ok: true, durationMs: 1 }; },
    });
    expect(out.logs).toEqual(['step 1', 'step 2']);
  });
});

describe('typed run failures', () => {
  it('types a validation refusal without touching the browser', async () => {
    const { backend, calls } = fakeBackend();
    const out = await runPlaybook({
      record: record({ valid: false, error: 'parse error at line 3', meta: undefined }),
      params: {}, caller: 'cli', createBackend: () => backend,
    });
    expect(out.ok).toBe(false);
    expect(out.type).toBe('Refused');
    expect(calls).toEqual([]);
    expect(out.evidence).toBeUndefined();
  });

  it('types a bad param set as Refused', async () => {
    const { backend } = fakeBackend();
    const out = await runPlaybook({
      record: record(), params: {}, caller: 'cli', createBackend: () => backend,
    });
    expect(out.type).toBe('Refused');
  });

  // The dead-branch regression lock. `mapCommand` runs BEFORE `unwrapTyped`,
  // so its refusal never passes through `classifyToolFailure` — with a plain
  // Error the run reported `HarnessUnavailable` ("the browser is gone") for a
  // command the harness simply declined, and the `Refused` branch in errors.ts
  // could never fire in production.
  //
  // Driven through the `runScript` seam rather than a real playbook because a
  // real one CANNOT reach here: permission-by-construction means a withheld
  // method is never built onto the `supersurf` object, and `METHODS` and the
  // command map's `MAP` have identical key sets. This boundary exists for a
  // forged or stale child that puts an arbitrary `method` on a `cmd` frame,
  // and the seam is the only way to present one.
  it('types a withheld method as Refused and persists that type to the sidecar', async () => {
    const { backend } = fakeBackend();
    const out = await runPlaybook({
      record: record(), params: { text: 'hi' }, caller: 'cli', createBackend: () => backend,
      runScript: async (opts: any) => {
        await opts.onCommand('connect', {});
        return { ok: true, durationMs: 1 };
      },
    });
    expect(out.ok).toBe(false);
    expect(out.type).toBe('Refused');
    expect(out.error).toContain('not available to playbook scripts');
    expect(readRunRecords('post_tweet')[0].type).toBe('Refused');
  });

  it('types an unknown method as Refused too', async () => {
    const { backend } = fakeBackend();
    const out = await runPlaybook({
      record: record(), params: { text: 'hi' }, caller: 'cli', createBackend: () => backend,
      runScript: async (opts: any) => {
        await opts.onCommand('teleport', {});
        return { ok: true, durationMs: 1 };
      },
    });
    expect(out.type).toBe('Refused');
  });

  it('types a failed connect as HarnessUnavailable', async () => {
    const backend: RunnerBackend = {
      async callTool(n) { return n === 'connect' ? { success: false, message: 'no daemon' } : { success: true }; },
    };
    const out = await runPlaybook({
      record: record(), params: { text: 'hi' }, caller: 'cli', createBackend: () => backend,
    });
    expect(out.type).toBe('HarnessUnavailable');
  });

  it('types a failed tab open as HarnessUnavailable', async () => {
    const backend: RunnerBackend = {
      async callTool(n, a: any) {
        if (n === 'connect') return { success: true };
        if (n === 'browser_tabs' && a.action === 'new') return { success: false, error: 'no window' };
        return { success: true };
      },
    };
    const out = await runPlaybook({
      record: record(), params: { text: 'hi' }, caller: 'cli', createBackend: () => backend,
    });
    expect(out.type).toBe('HarnessUnavailable');
  });

  // Runs the REAL sandbox, not the `runScript` seam, because the surviving
  // `at` is built in `host.ts` — its `handleCommand` catch spreads its own
  // `{ step, method }` over the classified payload. A seam-driven test would
  // assert an `at` that production overwrites.
  it('classifies a missing element and records which step threw', async () => {
    const { backend } = fakeBackend({
      browser_interact: { success: false, error: 'Element not found: .Layout-sidebar' },
    });
    const out = await runPlaybook({
      record: realRecord(`export default async function ({ supersurf }) {
  await supersurf.goto('https://example.com');
  await supersurf.click('.Layout-sidebar');
}
`),
      params: { text: 'hi' }, caller: 'cli', createBackend: () => backend,
    });
    expect(out.type).toBe('SelectorMiss');
    expect(out.at).toEqual({ step: 2, method: 'click' });
  });

  it('captures candidates for a SelectorMiss and never calls browser_snapshot', async () => {
    const calls: string[] = [];
    const backend: RunnerBackend = {
      async callTool(n) {
        calls.push(n);
        if (n === 'browser_evaluate') {
          return { url: 'https://example.com', title: 'Ex', candidates: [{ selector: 'div.SidebarAbout' }] };
        }
        return { success: true };
      },
    };
    const out = await runPlaybook({
      record: record(), params: { text: 'hi' }, caller: 'cli', createBackend: () => backend,
      runScript: async () => ({
        ok: false, error: 'Element not found: .Layout-sidebar',
        type: 'SelectorMiss', payload: { selector: '.Layout-sidebar' }, durationMs: 1,
      }),
    });
    expect(out.evidence?.candidates?.[0].selector).toContain('SidebarAbout');
    expect(calls).not.toContain('browser_snapshot');
  });

  it('captures candidates before closing the tab, not after', async () => {
    const { backend, calls } = fakeBackend({
      browser_evaluate: { url: 'https://example.com', title: 'Ex', candidates: [{ selector: 'div.SidebarAbout' }] },
    });
    await runPlaybook({
      record: record(), params: { text: 'hi' }, caller: 'cli', createBackend: () => backend,
      runScript: async () => ({
        ok: false, error: 'Element not found: .Layout-sidebar',
        type: 'SelectorMiss', payload: { selector: '.Layout-sidebar' }, durationMs: 1,
      }),
    });
    const evalIndex = calls.findIndex((c) => c.name === 'browser_evaluate');
    const closeIndex = calls.findIndex((c) => c.name === 'browser_tabs' && c.args?.action === 'close');
    expect(evalIndex).toBeGreaterThan(-1);
    expect(closeIndex).toBeGreaterThan(-1);
    expect(evalIndex).toBeLessThan(closeIndex);
  });

  it('captures NO page evidence for the five non-selector types', async () => {
    for (const type of ['Timeout', 'PageUnavailable', 'HarnessUnavailable', 'Refused', 'ScriptAssertion'] as const) {
      const calls: string[] = [];
      const backend: RunnerBackend = {
        async callTool(n) { calls.push(n); return { success: true }; },
      };
      const out = await runPlaybook({
        record: record(), params: { text: 'hi' }, caller: 'cli', createBackend: () => backend,
        runScript: async () => ({ ok: false, error: 'x', type, durationMs: 1 }),
      });
      expect(out.evidence, type).toBeUndefined();
      expect(calls, type).not.toContain('browser_snapshot');
      expect(calls, type).not.toContain('browser_evaluate');
    }
  });

  it('persists the stack for every in-child throw', async () => {
    const { backend } = fakeBackend();
    await runPlaybook({
      record: record(), params: { text: 'hi' }, caller: 'cli', createBackend: () => backend,
      runScript: async () => ({
        ok: false, error: 'boom', type: 'ScriptAssertion',
        stack: 'Error: boom\n  at playbook.js:3:9', durationMs: 1,
      }),
    });
    const [rec] = readRunRecords('post_tweet', 1);
    expect(rec.stack).toContain('playbook.js:3:9');
    expect(rec.type).toBe('ScriptAssertion');
  });

  it('keeps every stored failure record under the evidence cap', async () => {
    const backend: RunnerBackend = {
      async callTool(n) {
        if (n === 'browser_evaluate') {
          return {
            url: 'https://example.com', title: 'T',
            candidates: Array.from({ length: 40 }, (_, i) => ({ selector: `div.long-class-name-${i}`, text: 'y'.repeat(300) })),
          };
        }
        return { success: true };
      },
    };
    await runPlaybook({
      record: record(), params: { text: 'hi' }, caller: 'cli', createBackend: () => backend,
      runScript: async () => ({
        ok: false, error: 'Element not found: .x',
        type: 'SelectorMiss', payload: { selector: '.x' }, durationMs: 1,
      }),
    });
    const [rec] = readRunRecords('post_tweet', 1);
    expect(JSON.stringify(rec).length).toBeLessThan(6000);
  });
});
