import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { onPlaybooks } from '../src/tools/playbooks';
import { actionTrail } from '../src/playbooks/trail';
import { setBaseDirForTests, loadPlaybook, savePlaybook } from '../src/playbooks/store';
import { experimentRegistry } from '../src/experimental/index';

let dir: string;

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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-tool-'));
  setBaseDirForTests(dir);
  actionTrail._resetForTest();
  experimentRegistry.enable('fingerprinting');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  experimentRegistry.disable('fingerprinting');
});

describe('playbooks — gating', () => {
  it('refuses create when fingerprinting is disabled', async () => {
    experimentRegistry.disable('fingerprinting');
    seedTrail();
    const res = await onPlaybooks(makeCtx(), { action: 'create', name: 'x', purpose: 'p', steps: [1] }, {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('fingerprinting');
  });

  it('refuses run when fingerprinting is disabled', async () => {
    experimentRegistry.disable('fingerprinting');
    const res = await onPlaybooks(makeCtx(), { action: 'run', name: 'x' }, {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('fingerprinting');
  });

  it('allows history when fingerprinting is disabled', async () => {
    experimentRegistry.disable('fingerprinting');
    seedTrail();
    const res = await onPlaybooks(makeCtx(), { action: 'history' }, {});
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('#1');
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

describe('playbooks — create', () => {
  it('freezes the cited steps into a saved playbook', async () => {
    seedTrail();
    const res = await onPlaybooks(makeCtx(), { action: 'create', name: 'apply_to_job', purpose: 'Apply', steps: [1, 2] }, {});
    expect(res.isError).toBeFalsy();
    const pb = loadPlaybook('apply_to_job')!;
    expect(pb.steps).toHaveLength(2);
    expect(pb.steps[0].params).toEqual({ type: 'click', selector: '#a', name: 'apply_button' });
    expect(pb.steps[0].sourceId).toBe(1);
  });

  it('warns but still saves when a cited action failed at runtime', async () => {
    seedTrail();
    const res = await onPlaybooks(makeCtx(), { action: 'create', name: 'with_fail', purpose: 'p', steps: [1, 3] }, {});
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text.toLowerCase()).toContain('warn');
    expect(loadPlaybook('with_fail')!.steps).toHaveLength(2);
  });

  it('errors and refuses to save on a name collision', async () => {
    seedTrail();
    await onPlaybooks(makeCtx(), { action: 'create', name: 'dupe', purpose: 'first', steps: [1] }, {});
    const res = await onPlaybooks(makeCtx(), { action: 'create', name: 'dupe', purpose: 'second', steps: [2] }, {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('supersurf playbook rm dupe');
    expect(loadPlaybook('dupe')!.purpose).toBe('first');
  });

  it('errors on an unknown action id without saving anything', async () => {
    seedTrail();
    const res = await onPlaybooks(makeCtx(), { action: 'create', name: 'bad', purpose: 'p', steps: [1, 999] }, {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('999');
    expect(loadPlaybook('bad')).toBeNull();
  });

  it('errors when steps is empty', async () => {
    const res = await onPlaybooks(makeCtx(), { action: 'create', name: 'empty', purpose: 'p', steps: [] }, {});
    expect(res.isError).toBe(true);
    expect(loadPlaybook('empty')).toBeNull();
  });

  it('freezes non-interact tool calls into steps', async () => {
    actionTrail.record({ tool: 'browser_navigate', type: 'browser_navigate', outcome: 'ok', message: 'ok', params: { action: 'url', url: 'https://news.ycombinator.com' }, url: 'https://news.ycombinator.com' });
    actionTrail.record({ tool: 'browser_interact', type: 'click', outcome: 'ok', message: 'Clicked', params: { type: 'click', selector: '.subtext a' }, url: 'https://news.ycombinator.com' });
    actionTrail.record({ tool: 'browser_extract_content', type: 'browser_extract_content', outcome: 'ok', message: 'ok', params: { mode: 'auto' }, url: 'https://news.ycombinator.com/item?id=1' });
    const res = await onPlaybooks(makeCtx(), { action: 'create', name: 'hn_comments', purpose: 'p', steps: [1, 2, 3] }, {});
    expect(res.isError).toBeFalsy();
    const pb = loadPlaybook('hn_comments')!;
    expect(pb.steps.map(s => s.tool)).toEqual(['browser_navigate', 'browser_interact', 'browser_extract_content']);
    expect(pb.steps[0].params).toEqual({ action: 'url', url: 'https://news.ycombinator.com' });
  });

  it('still rejects atomically when one id is unknown in a mixed sequence', async () => {
    actionTrail.record({ tool: 'browser_navigate', type: 'browser_navigate', outcome: 'ok', message: 'ok', params: { action: 'url', url: 'https://x.com' }, url: 'https://x.com' });
    const res = await onPlaybooks(makeCtx(), { action: 'create', name: 'mixed_bad', purpose: 'p', steps: [1, 999] }, {});
    expect(res.isError).toBe(true);
    expect(loadPlaybook('mixed_bad')).toBeNull();
  });
});

describe('playbooks — run', () => {
  it('errors on an unknown playbook', async () => {
    const res = await onPlaybooks(makeCtx(), { action: 'run', name: 'ghost' }, {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('ghost');
  });

  it('executes steps in order and reports per-step progress', async () => {
    seedTrail();
    await onPlaybooks(makeCtx(), { action: 'create', name: 'flow', purpose: 'p', steps: [1, 2] }, {});
    const interact = vi.fn().mockResolvedValue('Clicked');
    const res = await onPlaybooks(makeCtx(), { action: 'run', name: 'flow' }, {}, { executeAction: interact });
    expect(interact).toHaveBeenCalledTimes(2);
    expect(res.content[0].text).toContain('1/2');
    expect(res.content[0].text).toContain('2/2');
  });

  it('stops at the first failing step and says which steps did not run', async () => {
    seedTrail();
    await onPlaybooks(makeCtx(), { action: 'create', name: 'flow', purpose: 'p', steps: [1, 2] }, {});
    const interact = vi.fn().mockRejectedValueOnce(new Error('Element not found')).mockResolvedValue('ok');
    const res = await onPlaybooks(makeCtx(), { action: 'run', name: 'flow' }, {}, { executeAction: interact });
    expect(res.isError).toBe(true);
    expect(interact).toHaveBeenCalledTimes(1);
    expect(res.content[0].text).toContain('Stopped at step 1');
  });

  it('notes that no heal was attempted for a verb healing does not cover', async () => {
    // Healing covers click/hover/drag only. A `type` failure must say so, or the
    // asymmetry looks like a bug rather than a known limitation.
    seedTrail();
    await onPlaybooks(makeCtx(), { action: 'create', name: 'typing', purpose: 'p', steps: [2] }, {});
    const interact = vi.fn().mockRejectedValue(new Error('Element not found'));
    const res = await onPlaybooks(makeCtx(), { action: 'run', name: 'typing' }, {}, { executeAction: interact });
    expect(res.content[0].text.toLowerCase()).toContain('no heal');
  });

  it('navigates to step 1 url when the browser is elsewhere', async () => {
    seedTrail();
    await onPlaybooks(makeCtx(), { action: 'create', name: 'flow', purpose: 'p', steps: [1] }, {});
    const nav = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const ctx = makeCtx('https://github.com/');
    await onPlaybooks(ctx, { action: 'run', name: 'flow' }, {}, {
      executeAction: vi.fn().mockResolvedValue('ok'), navigate: nav,
    });
    expect(nav).toHaveBeenCalled();
    expect(nav.mock.calls[0][1].url).toBe('https://linkedin.com/jobs/1234');
  });

  it('skips the navigation when already on step 1 url', async () => {
    seedTrail();
    await onPlaybooks(makeCtx(), { action: 'create', name: 'flow', purpose: 'p', steps: [1] }, {});
    const nav = vi.fn();
    await onPlaybooks(makeCtx('https://linkedin.com/jobs/1234'), { action: 'run', name: 'flow' }, {}, {
      executeAction: vi.fn().mockResolvedValue('ok'), navigate: nav,
    });
    expect(nav).not.toHaveBeenCalled();
  });

  it('records each executed step in the trail with a fresh id', async () => {
    seedTrail();
    await onPlaybooks(makeCtx(), { action: 'create', name: 'flow', purpose: 'p', steps: [1, 2] }, {});
    const before = actionTrail.size();
    await onPlaybooks(makeCtx(), { action: 'run', name: 'flow' }, {}, {
      executeAction: vi.fn().mockResolvedValue('ok'),
    });
    expect(actionTrail.size()).toBe(before + 2);
  });

  it('stops with an accurate message on a non-interact step, without calling exec', async () => {
    // Imported playbook files bypass create's validation, so a step can carry a
    // non-interact tool directly on disk. run must not hand it to executeAction
    // (which only knows interact verbs) or mislabel it with the heal note.
    savePlaybook({
      name: 'imported',
      purpose: 'p',
      steps: [{ tool: 'browser_navigate', type: 'browser_navigate', params: { action: 'url', url: 'https://x.com/' }, url: 'https://x.com/', sourceId: 1 }],
      createdAt: Date.now(),
      version: 1,
    });
    const interact = vi.fn().mockResolvedValue('ok');
    const res = await onPlaybooks(makeCtx('https://x.com/'), { action: 'run', name: 'imported' }, {}, { executeAction: interact });
    expect(res.isError).toBe(true);
    expect(interact).not.toHaveBeenCalled();
    expect(res.content[0].text).toContain('browser_navigate');
    expect(res.content[0].text.toLowerCase()).not.toContain('no heal');
  });
});

describe('playbooks — unknown action', () => {
  it('errors on an unrecognized action', async () => {
    const res = await onPlaybooks(makeCtx(), { action: 'frobnicate' }, {});
    expect(res.isError).toBe(true);
  });
});
