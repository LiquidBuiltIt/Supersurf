import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerAction,
  executeAction,
  getRegisteredActions,
  _clearRegistryForTest,
} from '../src/tools/interaction/registry';

describe('action registry', () => {
  beforeEach(() => _clearRegistryForTest());

  it('registers and dispatches an action by name', async () => {
    registerAction({ name: 'noop', run: async () => 'ran noop' });
    const result = await executeAction({} as any, { type: 'noop' });
    expect(result).toBe('ran noop');
  });

  it('throws when registering a duplicate name', () => {
    registerAction({ name: 'dup', run: async () => 'a' });
    expect(() => registerAction({ name: 'dup', run: async () => 'b' }))
      .toThrow(/already registered/);
  });

  it('throws when dispatching an unknown action type', async () => {
    await expect(executeAction({} as any, { type: 'nope' }))
      .rejects.toThrow(/Unknown action type: nope/);
  });

  it('lists registered action names', () => {
    registerAction({ name: 'a', run: async () => '' });
    registerAction({ name: 'b', run: async () => '' });
    expect(getRegisteredActions().sort()).toEqual(['a', 'b']);
  });
});

describe('executeAction recording', () => {
  beforeEach(() => _clearRegistryForTest());

  function recCtx() {
    return {
      config: { get: () => ({ logging: { action_recording: true } }) },
      connectionManager: { clientId: 's', getAttachedTab: () => ({ url: 'https://ex.com/' }) },
      metricsLogger: { write: vi.fn() },
    } as any;
  }

  it('executeAction records a successful action', async () => {
    _clearRegistryForTest();
    registerAction({ name: 'noop', run: async () => 'did noop' });
    const c = recCtx();
    const out = await executeAction(c, { type: 'noop', selector: '#x' });
    expect(out).toBe('did noop');
    expect(c.metricsLogger.write).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'action', result: 'ok',
        params: expect.objectContaining({ type: 'noop', selector: '#x', outcome: 'ok' }) }),
    );
  });

  it('executeAction records a failing action and re-throws', async () => {
    _clearRegistryForTest();
    registerAction({ name: 'boom', run: async () => { throw new Error('kaboom'); } });
    const c = recCtx();
    await expect(executeAction(c, { type: 'boom' })).rejects.toThrow('kaboom');
    expect(c.metricsLogger.write).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'error',
        params: expect.objectContaining({ type: 'boom', outcome: 'error', message: 'kaboom' }) }),
    );
  });

  it('unknown action type still throws before recording', async () => {
    _clearRegistryForTest();
    const c = recCtx();
    await expect(executeAction(c, { type: 'nope' })).rejects.toThrow(/Unknown action type/);
    expect(c.metricsLogger.write).not.toHaveBeenCalled();
  });
});

describe('action coverage', () => {
  it('registers all 15 documented browser_interact actions', async () => {
    // Force registration by importing the entry point (which side-effect-imports all actions)
    await import('../src/tools/interaction/index');
    const { getRegisteredActions } = await import('../src/tools/interaction/registry');
    const expected = [
      'click', 'type', 'clear', 'press_key', 'hover', 'wait',
      'mouse_move', 'mouse_click',
      'scroll_to', 'scroll_by', 'scroll_into_view',
      'select_option', 'select_custom',
      'file_upload', 'force_pseudo_state',
    ];
    const registered = getRegisteredActions();
    for (const name of expected) {
      expect(registered).toContain(name);
    }
  });
});
