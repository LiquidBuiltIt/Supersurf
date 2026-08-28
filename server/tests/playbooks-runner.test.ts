import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

/** Records every callTool the runner makes, in order. */
function fakeBackend(over: Partial<Record<string, any>> = {}): { backend: RunnerBackend; calls: any[] } {
  const calls: any[] = [];
  const backend: RunnerBackend = {
    async callTool(name: string, a: any) {
      calls.push({ name, args: a });
      if (name === 'connect') return { success: true };
      if (name === 'browser_tabs' && a.action === 'new') return { success: true, tabId: 77 };
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

  it('captures a snapshot as evidence when the script fails, before closing the tab', async () => {
    const { backend, calls } = fakeBackend();
    const out = await runPlaybook({
      record: record(), params: { text: 'hi' }, caller: 'agent',
      createBackend: () => backend,
      runScript: async () => ({ ok: false, error: 'tweet not visible after post', durationMs: 9 }),
    });
    expect(out.ok).toBe(false);
    expect(out.evidence?.snapshot).toBe('<page snapshot>');
    const names = calls.map(c => c.name);
    expect(names.indexOf('browser_snapshot')).toBeLessThan(
      names.lastIndexOf('browser_tabs'),
    );
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
