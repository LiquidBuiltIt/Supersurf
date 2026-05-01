import { describe, it, expect, beforeEach } from 'vitest';
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
