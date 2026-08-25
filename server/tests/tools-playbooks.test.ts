import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { onPlaybooks, resolveRunProfile } from '../src/tools/playbooks';
import { getToolSchemas } from '../src/tools/schemas';
import { actionTrail } from '../src/playbooks/trail';
import { setBaseDirForTests, loadPlaybook, savePlaybook } from '../src/playbooks/store';
import { experimentRegistry } from '../src/experimental/index';
import { formatResult } from '../src/tools/lib/result-formatter';

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

/** Shared shape for the `playbooks — create` cases: cite trail ids into a named playbook. */
function create(name: string, steps: number[], opts: { purpose?: string; ctx?: any } = {}) {
  const ctx = opts.ctx ?? makeCtx();
  return onPlaybooks(ctx, { action: 'create', name, purpose: opts.purpose ?? 'p', steps }, {});
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
    const res = await create('apply_to_job', [1, 2], { purpose: 'Apply' });
    expect(res.isError).toBeFalsy();
    const pb = loadPlaybook('apply_to_job')!;
    expect(pb.steps).toHaveLength(2);
    expect(pb.steps[0].params).toEqual({ type: 'click', selector: '#a', name: 'apply_button' });
    expect(pb.steps[0].sourceId).toBe(1);
  });

  it('stores the session\'s bound profile on the saved playbook', async () => {
    seedTrail();
    const ctx = makeCtx();
    ctx.connectionManager.profile = 'my-profile';
    const res = await create('profiled', [1], { ctx });
    expect(res.isError).toBeFalsy();
    expect(loadPlaybook('profiled')!.profile).toBe('my-profile');
  });

  it('omits the profile field when the session is unmanaged', async () => {
    seedTrail();
    const res = await create('unmanaged', [1]);
    expect(res.isError).toBeFalsy();
    expect(loadPlaybook('unmanaged')!.profile).toBeUndefined();
  });

  it('warns but still saves when a cited action failed at runtime', async () => {
    seedTrail();
    const res = await create('with_fail', [1, 3]);
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text.toLowerCase()).toContain('warn');
    expect(loadPlaybook('with_fail')!.steps).toHaveLength(2);
  });

  it('errors and refuses to save on a name collision', async () => {
    seedTrail();
    await create('dupe', [1], { purpose: 'first' });
    const res = await create('dupe', [2], { purpose: 'second' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('supersurf playbook rm dupe');
    expect(loadPlaybook('dupe')!.purpose).toBe('first');
  });

  it('errors on an unknown action id without saving anything', async () => {
    seedTrail();
    const res = await create('bad', [1, 999]);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('999');
    expect(loadPlaybook('bad')).toBeNull();
  });

  it('errors when steps is empty', async () => {
    const res = await create('empty', []);
    expect(res.isError).toBe(true);
    expect(loadPlaybook('empty')).toBeNull();
  });

  it('freezes non-interact tool calls into steps', async () => {
    actionTrail.record({ tool: 'browser_navigate', type: 'browser_navigate', outcome: 'ok', message: 'ok', params: { action: 'url', url: 'https://news.ycombinator.com' }, url: 'https://news.ycombinator.com' });
    actionTrail.record({ tool: 'browser_interact', type: 'click', outcome: 'ok', message: 'Clicked', params: { type: 'click', selector: '.subtext a' }, url: 'https://news.ycombinator.com' });
    actionTrail.record({ tool: 'browser_extract_content', type: 'browser_extract_content', outcome: 'ok', message: 'ok', params: { mode: 'auto' }, url: 'https://news.ycombinator.com/item?id=1' });
    const res = await create('hn_comments', [1, 2, 3]);
    expect(res.isError).toBeFalsy();
    const pb = loadPlaybook('hn_comments')!;
    expect(pb.steps.map(s => s.tool)).toEqual(['browser_navigate', 'browser_interact', 'browser_extract_content']);
    expect(pb.steps[0].params).toEqual({ action: 'url', url: 'https://news.ycombinator.com' });
  });

  it('still rejects atomically when one id is unknown in a mixed sequence', async () => {
    actionTrail.record({ tool: 'browser_navigate', type: 'browser_navigate', outcome: 'ok', message: 'ok', params: { action: 'url', url: 'https://x.com' }, url: 'https://x.com' });
    const res = await create('mixed_bad', [1, 999]);
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

  it('notes that no heal was attempted for force_pseudo_state, the one verb healing does not cover', async () => {
    // Every selector-resolving verb heals except force_pseudo_state (raw CDP
    // objectId path, no fingerprint to heal against). Its failure must say so,
    // or the asymmetry looks like a bug rather than a known limitation.
    actionTrail.record({
      tool: 'browser_interact', type: 'force_pseudo_state', outcome: 'ok', message: 'ok',
      params: { type: 'force_pseudo_state', selector: '#a', state: 'hover' },
      url: 'https://linkedin.com/jobs/1234',
    });
    await onPlaybooks(makeCtx(), { action: 'create', name: 'pseudo', purpose: 'p', steps: [1] }, {});
    const interact = vi.fn().mockRejectedValue(new Error('Element not found'));
    const res = await onPlaybooks(makeCtx(), { action: 'run', name: 'pseudo' }, {}, { executeAction: interact });
    expect(res.content[0].text.toLowerCase()).toContain('no heal');
  });

  it('does NOT note "no heal" for a healed verb (e.g. type) that fails', async () => {
    seedTrail();
    await onPlaybooks(makeCtx(), { action: 'create', name: 'typing', purpose: 'p', steps: [2] }, {});
    const interact = vi.fn().mockRejectedValue(new Error('Element not found'));
    const res = await onPlaybooks(makeCtx(), { action: 'run', name: 'typing' }, {}, { executeAction: interact });
    expect(res.content[0].text.toLowerCase()).not.toContain('no heal');
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

  it('replays a non-interact step generically instead of erroring on it', async () => {
    // Imported playbook files bypass create's validation, so a step can carry a
    // non-interact tool directly on disk. run must not hand it to executeAction
    // (which only knows interact verbs) — it replays through callHandler instead.
    savePlaybook({
      name: 'imported',
      purpose: 'p',
      steps: [{ tool: 'browser_navigate', type: 'browser_navigate', params: { action: 'url', url: 'https://x.com/' }, url: 'https://x.com/', sourceId: 1 }],
      createdAt: Date.now(),
      version: 1,
    });
    const interact = vi.fn().mockResolvedValue('ok');
    const callHandler = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const res = await onPlaybooks(makeCtx('https://x.com/'), { action: 'run', name: 'imported' }, {}, { executeAction: interact, callHandler });
    expect(res.isError).toBeFalsy();
    expect(interact).not.toHaveBeenCalled();
    expect(callHandler).toHaveBeenCalledWith(
      expect.anything(), 'browser_navigate', { action: 'url', url: 'https://x.com/' }, { rawResult: false },
    );
  });
});

describe('playbooks — run (generic steps)', () => {
  function seedMixedPlaybook() {
    savePlaybook({
      name: 'mixed_flow',
      purpose: 'p',
      steps: [
        { tool: 'browser_navigate', type: 'browser_navigate', params: { action: 'url', url: 'https://news.ycombinator.com' }, url: 'https://news.ycombinator.com', sourceId: 1 },
        { tool: 'browser_interact', type: 'click', params: { type: 'click', selector: '.subtext a' }, url: 'https://news.ycombinator.com', sourceId: 2 },
        { tool: 'browser_extract_content', type: 'browser_extract_content', params: { mode: 'auto' }, url: 'https://news.ycombinator.com/item?id=1', sourceId: 3 },
      ],
      createdAt: 1,
      version: 1,
    });
  }

  it('replays non-interact steps through callHandler and appends their output', async () => {
    seedMixedPlaybook();
    const callHandler = vi.fn()
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"success":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'COMMENT BODY TEXT' }] });
    const executeAction = vi.fn().mockResolvedValue('Clicked');
    const navigate = vi.fn();
    const res = await onPlaybooks(makeCtx('https://news.ycombinator.com'), { action: 'run', name: 'mixed_flow' }, {}, { executeAction, navigate, callHandler });
    expect(res.isError).toBeFalsy();
    expect(callHandler).toHaveBeenNthCalledWith(1, expect.anything(), 'browser_navigate', { action: 'url', url: 'https://news.ycombinator.com' }, { rawResult: false });
    expect(callHandler).toHaveBeenNthCalledWith(2, expect.anything(), 'browser_extract_content', { mode: 'auto' }, { rawResult: false });
    expect(executeAction).toHaveBeenCalledTimes(1);
    expect(res.content[0].text).toContain('COMMENT BODY TEXT');
    expect(res.content[0].text).toContain('3/3');
  });

  it('skips the start-URL auto-navigate when step 1 is itself a navigate', async () => {
    seedMixedPlaybook();
    const callHandler = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const executeAction = vi.fn().mockResolvedValue('Clicked');
    const navigate = vi.fn();
    // Live URL differs from steps[0].url — without the guard this would fire deps.navigate.
    await onPlaybooks(makeCtx('https://somewhere-else.com/'), { action: 'run', name: 'mixed_flow' }, {}, { executeAction, navigate, callHandler });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('skips the start-URL auto-navigate when step 1 opens a new tab', async () => {
    // browser_tabs new lands on its own URL in a fresh tab; pre-navigating the
    // old tab would load the page twice and would fail outright with no tab attached.
    savePlaybook({
      name: 'tab_first',
      purpose: 'p',
      steps: [
        { tool: 'browser_tabs', type: 'browser_tabs', params: { action: 'new', url: 'https://news.ycombinator.com' }, url: 'https://news.ycombinator.com', sourceId: 1 },
        { tool: 'browser_extract_content', type: 'browser_extract_content', params: { mode: 'auto' }, url: 'https://news.ycombinator.com', sourceId: 2 },
      ],
      createdAt: 1,
      version: 1,
    });
    const callHandler = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const navigate = vi.fn();
    const res = await onPlaybooks(makeCtx('https://somewhere-else.com/'), { action: 'run', name: 'tab_first' }, {}, { executeAction: vi.fn(), navigate, callHandler });
    expect(navigate).not.toHaveBeenCalled();
    expect(res.isError).toBeFalsy();
    expect(callHandler).toHaveBeenNthCalledWith(1, expect.anything(), 'browser_tabs', { action: 'new', url: 'https://news.ycombinator.com' }, { rawResult: false });
  });

  it('stops the run when a generic step returns isError', async () => {
    seedMixedPlaybook();
    const callHandler = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Extension not connected' }], isError: true });
    const executeAction = vi.fn();
    const res = await onPlaybooks(makeCtx('https://news.ycombinator.com'), { action: 'run', name: 'mixed_flow' }, {}, { executeAction, navigate: vi.fn(), callHandler });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Stopped at step 1 of 3');
    expect(executeAction).not.toHaveBeenCalled();
  });

  it('fails loudly on a step whose tool is unknown (hand-edited import)', async () => {
    savePlaybook({
      name: 'bogus_tool_flow',
      purpose: 'p',
      steps: [{ tool: 'no_such_tool', type: 'no_such_tool', params: {}, url: 'https://x.com/', sourceId: 1 }],
      createdAt: 1,
      version: 1,
    });
    const callHandler = vi.fn().mockResolvedValue(null);
    const res = await onPlaybooks(makeCtx('https://x.com/'), { action: 'run', name: 'bogus_tool_flow' }, {}, { executeAction: vi.fn(), navigate: vi.fn(), callHandler });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Unknown tool');
    expect(res.content[0].text).toContain('no_such_tool');
  });

  it('strips the connection status header a real handler prepends via formatResult', async () => {
    // Regression for the header-leak finding: handlers reached through
    // callHandler route through ctx.formatResult, which unconditionally
    // prepends the status header. Exercise the REAL formatResult (not a
    // pre-cleaned mock) so this actually proves the strip works against
    // its real output shape.
    seedMixedPlaybook();
    const fakeCm = { statusHeader: () => '✅ v3.4.0 | 🌐 chrome | 📄 Tab 1: https://news.ycombinator.com\n---\n\n' };
    const callHandler = vi.fn(async (_ctx: any, toolName: string, toolArgs: any, options: any) => {
      const raw = toolName === 'browser_navigate'
        ? { message: `Navigated to ${toolArgs.url}` }
        : { text: 'COMMENT BODY TEXT' };
      return formatResult(toolName, raw, options, fakeCm);
    });
    const executeAction = vi.fn().mockResolvedValue('Clicked');
    const res = await onPlaybooks(makeCtx('https://news.ycombinator.com'), { action: 'run', name: 'mixed_flow' }, {}, { executeAction, navigate: vi.fn(), callHandler });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('COMMENT BODY TEXT');
    expect(res.content[0].text).not.toContain('\n---\n');
    expect(res.content[0].text).not.toContain('✅');
  });

  it('strips the status header from an isError step and still surfaces the error', async () => {
    seedMixedPlaybook();
    const fakeCm = { statusHeader: () => '✅ v3.4.0 | 🌐 chrome | 📄 Tab 1: https://news.ycombinator.com\n---\n\n' };
    const callHandler = vi.fn()
      .mockResolvedValueOnce(formatResult('browser_navigate', { message: 'Navigated to https://news.ycombinator.com' }, { rawResult: false }, fakeCm))
      .mockResolvedValueOnce({ content: [{ type: 'text', text: fakeCm.statusHeader() + 'Extension not connected' }], isError: true });
    const executeAction = vi.fn().mockResolvedValue('Clicked');
    const res = await onPlaybooks(makeCtx('https://news.ycombinator.com'), { action: 'run', name: 'mixed_flow' }, {}, { executeAction, navigate: vi.fn(), callHandler });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Extension not connected');
    expect(res.content[0].text).not.toContain('\n---\n');
    expect(res.content[0].text).not.toContain('✅');
    expect(res.content[0].text).toContain('Stopped at step 3 of 3');
  });

  it('preserves a _recovery note when stripping the status header from a replayed step', async () => {
    seedMixedPlaybook();
    const fakeCm = { statusHeader: () => '✅ v3.4.0 | 🌐 chrome | 📄 Tab 1: https://news.ycombinator.com\n---\n\n' };
    const callHandler = vi.fn()
      .mockResolvedValueOnce(formatResult('browser_navigate', { message: 'Navigated to https://news.ycombinator.com' }, { rawResult: false }, fakeCm))
      .mockResolvedValueOnce(formatResult(
        'browser_extract_content',
        { _recovery: { previousTabId: 5, newTabId: 7, url: 'https://news.ycombinator.com/item?id=1' }, text: 'COMMENT BODY TEXT' },
        { rawResult: false },
        fakeCm,
      ));
    const executeAction = vi.fn().mockResolvedValue('Clicked');
    const res = await onPlaybooks(makeCtx('https://news.ycombinator.com'), { action: 'run', name: 'mixed_flow' }, {}, { executeAction, navigate: vi.fn(), callHandler });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('tab recovered: stale tab 5 → 7');
    expect(res.content[0].text).toContain('COMMENT BODY TEXT');
    expect(res.content[0].text).not.toContain('\n---\n');
  });

  it('attaches a dialog notice under the step that raised it, not at the end of the run', async () => {
    seedMixedPlaybook();
    const consumeDialogEvents = vi.fn()
      .mockReturnValueOnce([]) // step 1 (navigate)
      .mockReturnValueOnce([{ type: 'confirm', message: 'Are you sure?', defaultPrompt: '', url: 'https://news.ycombinator.com', hasBrowserHandler: false, timestamp: Date.now() }]) // step 2 (interact)
      .mockReturnValueOnce([]); // step 3 (extract_content)
    const ctx = makeCtx('https://news.ycombinator.com');
    ctx.ext.consumeDialogEvents = consumeDialogEvents;
    const callHandler = vi.fn()
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'COMMENT BODY TEXT' }] });
    const executeAction = vi.fn().mockResolvedValue('Clicked');
    const res = await onPlaybooks(ctx, { action: 'run', name: 'mixed_flow' }, {}, { executeAction, navigate: vi.fn(), callHandler });
    expect(res.isError).toBeFalsy();
    expect(consumeDialogEvents).toHaveBeenCalledTimes(3);
    const text = res.content[0].text;
    const noticeIdx = text.indexOf('⚠ A native confirm dialog');
    expect(noticeIdx).toBeGreaterThan(-1);
    expect(text.indexOf('2/3')).toBeLessThan(noticeIdx);
    expect(noticeIdx).toBeLessThan(text.indexOf('3/3'));
  });

  it('appends the inline screenshot blob when the replayed step had no path', async () => {
    savePlaybook({
      name: 'shot_inline',
      purpose: 'p',
      steps: [{ tool: 'browser_take_screenshot', type: 'browser_take_screenshot', params: {}, url: 'https://x.com/', sourceId: 1 }],
      createdAt: 1,
      version: 1,
    });
    const callHandler = vi.fn().mockResolvedValue({
      content: [
        { type: 'text', text: 'Screenshot captured' },
        { type: 'image', data: 'BASE64DATA', mimeType: 'image/jpeg' },
      ],
    });
    const res = await onPlaybooks(makeCtx('https://x.com/'), { action: 'run', name: 'shot_inline' }, {}, { executeAction: vi.fn(), navigate: vi.fn(), callHandler });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].type).toBe('text');
    const imageBlock = res.content.find((b: any) => b.type === 'image');
    expect(imageBlock).toEqual({ type: 'image', data: 'BASE64DATA', mimeType: 'image/jpeg' });
  });

  it('does not add an image block for a path-recorded screenshot step', async () => {
    savePlaybook({
      name: 'shot_path',
      purpose: 'p',
      steps: [{ tool: 'browser_take_screenshot', type: 'browser_take_screenshot', params: { path: '/tmp/x.jpg' }, url: 'https://x.com/', sourceId: 1 }],
      createdAt: 1,
      version: 1,
    });
    const callHandler = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Screenshot saved to /tmp/x.jpg (123 bytes)' }],
    });
    const res = await onPlaybooks(makeCtx('https://x.com/'), { action: 'run', name: 'shot_path' }, {}, { executeAction: vi.fn(), navigate: vi.fn(), callHandler });
    expect(res.isError).toBeFalsy();
    expect(res.content.some((b: any) => b.type === 'image')).toBe(false);
    expect(res.content).toHaveLength(1);
  });
});

describe('playbooks — unknown action', () => {
  it('errors on an unrecognized action', async () => {
    const res = await onPlaybooks(makeCtx(), { action: 'frobnicate' }, {});
    expect(res.isError).toBe(true);
  });
});

describe('playbooks — list', () => {
  it('says so plainly when the store is empty', async () => {
    const res = await onPlaybooks(makeCtx(), { action: 'list' }, {});
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text.toLowerCase()).toContain('no playbooks');
  });

  it('lists every playbook with name, purpose, step count and domains', async () => {
    seedTrail();
    await create('flow_a', [1, 2], { purpose: 'Does A' });
    savePlaybook({
      name: 'flow_b', purpose: 'Does B', version: 1, createdAt: 1,
      steps: [{ tool: 'browser_navigate', type: 'browser_navigate', params: {}, url: 'https://github.com/', sourceId: 1 }],
    });

    const res = await onPlaybooks(makeCtx(), { action: 'list' }, {});
    expect(res.isError).toBeFalsy();
    const text = res.content[0].text;
    expect(text).toContain('flow_a');
    expect(text).toContain('Does A');
    expect(text).toContain('2 steps');
    expect(text).toContain('flow_b');
    expect(text).toContain('github.com');
  });

  it('includes the bound profile when set', async () => {
    seedTrail();
    const ctx = makeCtx();
    ctx.connectionManager.profile = 'my-profile';
    await create('profiled', [1], { ctx });

    const res = await onPlaybooks(makeCtx(), { action: 'list' }, {});
    expect(res.content[0].text).toContain('profile: my-profile');
  });

  it('filters by domain, normalized the same way as the derivation', async () => {
    savePlaybook({
      name: 'gh_flow', purpose: 'p', version: 1, createdAt: 1,
      steps: [{ tool: 'browser_navigate', type: 'browser_navigate', params: {}, url: 'https://www.github.com/', sourceId: 1 }],
    });
    savePlaybook({
      name: 'other_flow', purpose: 'p', version: 1, createdAt: 1,
      steps: [{ tool: 'browser_navigate', type: 'browser_navigate', params: {}, url: 'https://example.com/', sourceId: 1 }],
    });

    const res = await onPlaybooks(makeCtx(), { action: 'list', domain: 'github.com' }, {});
    expect(res.content[0].text).toContain('gh_flow');
    expect(res.content[0].text).not.toContain('other_flow');
  });

  it('says so plainly when the domain filter matches nothing', async () => {
    savePlaybook({ name: 'gh_flow', purpose: 'p', version: 1, createdAt: 1, steps: [] });
    const res = await onPlaybooks(makeCtx(), { action: 'list', domain: 'nowhere.com' }, {});
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('nowhere.com');
  });

  it('does not require the fingerprinting experiment', async () => {
    experimentRegistry.disable('fingerprinting');
    savePlaybook({ name: 'x', purpose: 'p', version: 1, createdAt: 1, steps: [] });
    const res = await onPlaybooks(makeCtx(), { action: 'list' }, {});
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('x');
  });
});

describe('playbooks — inspect', () => {
  it('errors clearly on an unknown playbook name', async () => {
    const res = await onPlaybooks(makeCtx(), { action: 'inspect', name: 'ghost' }, {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('ghost');
  });

  it('errors when name is missing', async () => {
    const res = await onPlaybooks(makeCtx(), { action: 'inspect' }, {});
    expect(res.isError).toBe(true);
  });

  it('renders full detail: purpose, domains, createdAt, and the numbered step list', async () => {
    savePlaybook({
      name: 'gh_login', purpose: 'Log into GitHub', version: 1, createdAt: 1_700_000_000_000,
      profile: 'work',
      steps: [
        { tool: 'browser_navigate', type: 'browser_navigate', params: { action: 'url', url: 'https://github.com/login' }, url: 'https://github.com/login', sourceId: 1 },
        { tool: 'browser_interact', type: 'click', params: { type: 'click', selector: '#submit' }, url: 'https://github.com/login', sourceId: 2 },
      ],
    });

    const res = await onPlaybooks(makeCtx(), { action: 'inspect', name: 'gh_login' }, {});
    expect(res.isError).toBeFalsy();
    const text = res.content[0].text;
    expect(text).toContain('gh_login');
    expect(text).toContain('Log into GitHub');
    expect(text).toContain('profile: work');
    expect(text).toContain('github.com');
    expect(text).toContain('browser_navigate');
    expect(text).toContain('browser_interact');
    expect(text).toContain('click');
    expect(text).toContain('https://github.com/login');
    expect(text).toMatch(/1\.\s+browser_navigate/);
    expect(text).toMatch(/2\.\s+browser_interact/);
  });

  it('omits the profile line when unset', async () => {
    savePlaybook({ name: 'unmanaged_pb', purpose: 'p', version: 1, createdAt: 1, steps: [] });
    const res = await onPlaybooks(makeCtx(), { action: 'inspect', name: 'unmanaged_pb' }, {});
    expect(res.content[0].text).not.toContain('profile:');
  });

  it('does not require the fingerprinting experiment', async () => {
    experimentRegistry.disable('fingerprinting');
    savePlaybook({ name: 'x', purpose: 'p', version: 1, createdAt: 1, steps: [] });
    const res = await onPlaybooks(makeCtx(), { action: 'inspect', name: 'x' }, {});
    expect(res.isError).toBeFalsy();
  });
});

describe('playbooks — create invalidates the connection manager\'s playbook index', () => {
  it('calls ctx.connectionManager.invalidatePlaybookIndex() after a successful save', async () => {
    seedTrail();
    const ctx = makeCtx();
    ctx.connectionManager.invalidatePlaybookIndex = vi.fn();
    await create('flow', [1], { ctx });
    expect(ctx.connectionManager.invalidatePlaybookIndex).toHaveBeenCalledTimes(1);
  });

  it('does not throw when the hook is absent (e.g. a CLI-driven create)', async () => {
    seedTrail();
    const res = await create('flow_no_hook', [1]);
    expect(res.isError).toBeFalsy();
  });
});

describe('playbooks — schema', () => {
  it('includes list and inspect in the action enum, alongside the existing actions', () => {
    const schema = getToolSchemas().find(s => s.name === 'playbooks')!;
    const actionEnum = (schema.inputSchema as any).properties.action.enum;
    expect(actionEnum).toEqual(expect.arrayContaining(['history', 'create', 'run', 'list', 'inspect']));
  });

  it('has a domain property for the list filter', () => {
    const schema = getToolSchemas().find(s => s.name === 'playbooks')!;
    expect((schema.inputSchema as any).properties.domain).toBeDefined();
  });
});

describe('resolveRunProfile', () => {
  it('prefers the explicit profile arg over the playbook field', () => {
    savePlaybook({ name: 'p1', purpose: 'p', steps: [], createdAt: 1, version: 1, profile: 'field-profile' });
    expect(resolveRunProfile({ name: 'p1', profile: 'arg-profile' })).toBe('arg-profile');
  });

  it('falls back to the playbook\'s own profile field when no explicit profile is given', () => {
    savePlaybook({ name: 'p2', purpose: 'p', steps: [], createdAt: 1, version: 1, profile: 'field-profile' });
    expect(resolveRunProfile({ name: 'p2' })).toBe('field-profile');
  });

  it('resolves to undefined when neither an explicit profile nor a playbook field is set', () => {
    savePlaybook({ name: 'p3', purpose: 'p', steps: [], createdAt: 1, version: 1 });
    expect(resolveRunProfile({ name: 'p3' })).toBeUndefined();
  });

  it('resolves to undefined for an unknown playbook name with no explicit profile', () => {
    expect(resolveRunProfile({ name: 'ghost' })).toBeUndefined();
  });
});
