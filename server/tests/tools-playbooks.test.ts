import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { onPlaybooks } from '../src/tools/playbooks';
import { getToolSchemas } from '../src/tools/schemas';
import { actionTrail } from '../src/playbooks/trail';
import { experimentRegistry } from '../src/experimental/index';
import { setPlaybooksDirForTests, playbookFile } from '../src/playbooks/paths';
import {
  refreshRegistry, resetRegistryForTests, setValidatorForTests,
} from '../src/playbooks/registry';
import type { ValidationRecord } from '../src/security/validate';

function makeCtx(url = 'https://linkedin.com/jobs/1234'): any {
  return {
    ext: { sendCmd: vi.fn().mockResolvedValue({ tabs: [{ id: 1, url, attached: true }], attachedTabId: 1 }) },
    connectionManager: { getAttachedTab: () => ({ url }), clientId: 'test' },
    config: { get: () => ({ tips: false }) },
    sleep: vi.fn(),
    error: (m: string) => ({ content: [{ type: 'text', text: m }], isError: true }),
  };
}

function seedTrail() {
  actionTrail.record({ tool: 'browser_interact', type: 'click', outcome: 'ok', message: 'Clicked', params: { type: 'click', selector: '#a', name: 'apply_button' }, url: 'https://linkedin.com/jobs/1234' });
  actionTrail.record({ tool: 'browser_interact', type: 'type', outcome: 'ok', message: 'Typed', params: { type: 'type', selector: '#b' }, url: 'https://linkedin.com/jobs/1234' });
  actionTrail.record({ tool: 'browser_interact', type: 'click', outcome: 'error', message: 'not found', params: { type: 'click', selector: '#ghost' }, url: 'https://linkedin.com/jobs/1234' });
}

beforeEach(() => {
  actionTrail._resetForTest();
  experimentRegistry.enable('test', 'fingerprinting');
});
afterEach(() => {
  experimentRegistry.disable('test', 'fingerprinting');
});

describe('playbooks — gating', () => {
  it('refuses run when fingerprinting is disabled', async () => {
    experimentRegistry.disable('test', 'fingerprinting');
    const res = await onPlaybooks(makeCtx(), { action: 'run', name: 'x' }, {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('fingerprinting');
  });

  it('allows history when fingerprinting is disabled', async () => {
    experimentRegistry.disable('test', 'fingerprinting');
    seedTrail();
    const res = await onPlaybooks(makeCtx(), { action: 'history' }, {});
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('#1');
  });

  it('allows the report actions when fingerprinting is disabled', async () => {
    experimentRegistry.disable('test', 'fingerprinting');
    for (const action of ['list', 'validate']) {
      const res = await onPlaybooks(makeCtx(), { action }, {});
      expect(res.content[0].text).not.toContain('fingerprinting');
    }
  });
});

describe('playbooks — history', () => {
  it('returns the recorded actions', async () => {
    seedTrail();
    const res = await onPlaybooks(makeCtx(), { action: 'history' }, {});
    expect(res.content[0].text).toContain('#1');
    expect(res.content[0].text).toContain('apply_button');
  });

  it('honors limit and offset', async () => {
    for (let i = 0; i < 100; i++) {
      actionTrail.record({ tool: 't', type: 'click', outcome: 'ok', message: 'm', params: {}, url: 'https://x.com/' });
    }
    const res = await onPlaybooks(makeCtx(), { action: 'history', limit: 5, offset: 10 }, {});
    expect(res.content[0].text).toContain('#86');
    expect(res.content[0].text).toContain('#90');
    expect(res.content[0].text).not.toContain('#91');
  });
});

describe('playbooks — unknown action', () => {
  it('errors on an unrecognized action', async () => {
    const res = await onPlaybooks(makeCtx(), { action: 'frobnicate' }, {});
    expect(res.isError).toBe(true);
  });
});

describe('playbooks — schema', () => {
  it('exposes the script action set and no longer offers create', () => {
    const schema = getToolSchemas().find(s => s.name === 'playbooks')!;
    const actionEnum = (schema.inputSchema as any).properties.action.enum;
    expect(actionEnum).toEqual(['history', 'list', 'inspect', 'validate', 'run']);
    expect(actionEnum).not.toContain('create');
  });

  it('has a domain property for the list filter', () => {
    const schema = getToolSchemas().find(s => s.name === 'playbooks')!;
    expect((schema.inputSchema as any).properties.domain).toBeDefined();
  });

  it('has params and profile properties for run', () => {
    const props = (getToolSchemas().find(s => s.name === 'playbooks')!.inputSchema as any).properties;
    expect(props.params).toBeDefined();
    expect(props.profile).toBeDefined();
  });
});

describe('playbooks — script surface', () => {
  let dir: string;

  function rec(name: string, over: Partial<ValidationRecord> = {}): ValidationRecord {
    return {
      file: playbookFile(name), name, hash: name, valid: true,
      meta: {
        description: `does ${name}`, startingPoint: 'example.com',
        params: { text: { type: 'string', required: true } },
      },
      signature: `${name}({ text })`, validatedAt: 1,
      ...over,
    };
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-tool-'));
    setPlaybooksDirForTests(dir);
    resetRegistryForTests();
    fs.writeFileSync(playbookFile('post_tweet'), '// ok');
    fs.writeFileSync(playbookFile('broken'), '// bad');
    setValidatorForTests(async (p: string) =>
      p.includes('broken')
        ? rec('broken', { valid: false, meta: undefined, error: 'blocked API: require' })
        : rec('post_tweet'));
    await refreshRegistry();
  });

  afterEach(() => {
    setValidatorForTests(null);
    resetRegistryForTests();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const ctx: any = { connectionManager: { config: { configService: { get: () => ({ security: { playbook_eval: true } }) } } } };

  it('list shows the signature, description and starting point', async () => {
    const out = await onPlaybooks(ctx, { action: 'list' }, {});
    const body = out.content[0].text;
    expect(body).toContain('post_tweet({ text })');
    expect(body).toContain('does post_tweet');
    expect(body).toContain('example.com');
  });

  it('list flags an invalid playbook instead of hiding it', async () => {
    const body = (await onPlaybooks(ctx, { action: 'list' }, {})).content[0].text;
    expect(body).toContain('broken');
    expect(body).toContain('blocked API: require');
  });

  it('list filters by domain against meta.startingPoint', async () => {
    const body = (await onPlaybooks(ctx, { action: 'list', domain: 'nowhere.test' }, {})).content[0].text;
    expect(body).toContain('No playbooks match');
  });

  it('inspect renders the param table and the run history', async () => {
    const body = (await onPlaybooks(ctx, { action: 'inspect', name: 'post_tweet' }, {})).content[0].text;
    expect(body).toContain('text');
    expect(body).toContain('required');
    expect(body).toContain('never run');
  });

  it('inspect reports an unknown name as an error', async () => {
    const out = await onPlaybooks(ctx, { action: 'inspect', name: 'nope' }, {});
    expect(out.isError).toBe(true);
  });

  it('validate reports every playbook when no name is given', async () => {
    const body = (await onPlaybooks(ctx, { action: 'validate' }, {})).content[0].text;
    expect(body).toContain('✓ post_tweet');
    expect(body).toContain('✗ broken');
  });

  it('validate returns isError when the named playbook is invalid', async () => {
    const out = await onPlaybooks(ctx, { action: 'validate', name: 'broken' }, {});
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain('blocked API: require');
  });

  it('run rejects an invalid playbook without invoking the runner', async () => {
    let called = false;
    const out = await onPlaybooks(ctx, { action: 'run', name: 'broken' }, {},
      { runPlaybook: async () => { called = true; return { ok: true, durationMs: 1, logs: [] }; } });
    expect(called).toBe(false);
    expect(out.isError).toBe(true);
  });

  it('run passes params and profile through to the runner', async () => {
    let seen: any = null;
    await onPlaybooks(ctx, { action: 'run', name: 'post_tweet', params: { text: 'hi' }, profile: 'dev' }, {},
      { runPlaybook: async (o: any) => { seen = o; return { ok: true, result: 'done', durationMs: 3, logs: [] }; } });
    expect(seen.params).toEqual({ text: 'hi' });
    expect(seen.profile).toBe('dev');
    expect(seen.caller).toBe('agent');
  });

  it('run renders logs, the result and the duration', async () => {
    const out = await onPlaybooks(ctx, { action: 'run', name: 'post_tweet', params: { text: 'hi' } }, {},
      { runPlaybook: async () => ({ ok: true, result: { id: 7 }, durationMs: 1234, logs: ['step 1'] }) });
    const body = out.content[0].text;
    expect(body).toContain('step 1');
    expect(body).toContain('"id": 7');
    expect(body).toContain('1234ms');
  });

  it('run surfaces the failure evidence on a failed run', async () => {
    const out = await onPlaybooks(ctx, { action: 'run', name: 'post_tweet', params: { text: 'hi' } }, {},
      {
        runPlaybook: async () => ({
          ok: false, error: 'tweet not visible', durationMs: 9, logs: [],
          type: 'SelectorMiss', at: { step: 1, method: 'click' },
          evidence: { url: 'https://example.com', candidates: [{ selector: '.SidebarAbout' }] },
        }),
      });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain('tweet not visible');
    expect(out.content[0].text).toContain('.SidebarAbout');
  });

  it('run refuses an eval playbook for an agent when security.playbook_eval is false', async () => {
    setValidatorForTests(async () => rec('post_tweet', { meta: { description: 'x', permissions: ['eval'] } }));
    resetRegistryForTests();
    await refreshRegistry();
    const offCtx: any = { connectionManager: { config: { configService: { get: () => ({ security: { playbook_eval: false } }) } } } };
    let called = false;
    const out = await onPlaybooks(offCtx, { action: 'run', name: 'post_tweet' }, {},
      { runPlaybook: async () => { called = true; return { ok: true, durationMs: 1, logs: [] }; } });
    expect(called).toBe(false);
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain('security.playbook_eval');
  });

  it('rejects the deleted create action by name', async () => {
    const out = await onPlaybooks(ctx, { action: 'create', name: 'x' }, {});
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain('no longer exists');
  });
});
