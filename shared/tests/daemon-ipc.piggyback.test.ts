import { describe, it, expect, vi } from 'vitest';
import { takePiggyback } from '../index';

const dlg = { type: 'alert', message: 'm', defaultPrompt: '', url: 'u', hasBrowserHandler: false, timestamp: 1 } as const;

describe('takePiggyback', () => {
  it('calls the tab callback when currentTab is present', () => {
    const cb = vi.fn();
    takePiggyback({ currentTab: { id: 7 } }, cb);
    expect(cb).toHaveBeenCalledWith({ id: 7 });
  });

  it('returns the dialogs and strips _dialogs from the result', () => {
    const result: any = { ok: true, _dialogs: [dlg] };
    expect(takePiggyback(result, null)).toEqual([dlg]);
    expect('_dialogs' in result).toBe(false);
  });

  it('strips an empty _dialogs array and returns nothing', () => {
    const result: any = { _dialogs: [] };
    expect(takePiggyback(result, null)).toEqual([]);
    expect('_dialogs' in result).toBe(false);
  });

  it('ignores non-object results', () => {
    expect(takePiggyback('x', vi.fn())).toEqual([]);
    expect(takePiggyback(null, null)).toEqual([]);
  });
});
