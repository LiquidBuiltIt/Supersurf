import { describe, it, expect, vi } from 'vitest';
import { recordAction } from '../src/recorder/action-recorder';

function ctx(enabled: boolean) {
  return {
    config: { get: () => ({ logging: { action_recording: enabled } }) },
    connectionManager: { clientId: 'sid', getAttachedTab: () => ({ url: 'https://ex.com/jobs' }) },
    metricsLogger: { write: vi.fn() },
  } as any;
}

describe('recordAction', () => {
  it('gate OFF: writes nothing', () => {
    const c = ctx(false);
    recordAction(c, { type: 'click', selector: '#go' }, 1000, 'Clicked #go', null);
    expect(c.metricsLogger.write).not.toHaveBeenCalled();
  });

  it('gate ON + success: records type, selector target, ok outcome, message', () => {
    const c = ctx(true);
    recordAction(c, { type: 'click', selector: '#go' }, 1000, 'Clicked #go at (5, 6)', null);
    expect(c.metricsLogger.write).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: 'action', result: 'ok', url: 'https://ex.com/jobs', session_id: 'sid',
        params: expect.objectContaining({
          event: 'action', type: 'click', selector: '#go', x: null, y: null,
          outcome: 'ok', message: 'Clicked #go at (5, 6)',
        }),
      }),
    );
  });

  it('gate ON + coordinate action: records x/y target, null selector', () => {
    const c = ctx(true);
    recordAction(c, { type: 'mouse_click', x: 100, y: 200 }, 1000, 'Clicked at (100, 200)', null);
    expect(c.metricsLogger.write).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ type: 'mouse_click', selector: null, x: 100, y: 200, outcome: 'ok' }),
      }),
    );
  });

  it('gate ON + error: records error outcome + truncated error message', () => {
    const c = ctx(true);
    recordAction(c, { type: 'click', selector: '#missing' }, 1000, null, new Error('Element not found'));
    expect(c.metricsLogger.write).toHaveBeenCalledWith(
      expect.objectContaining({
        result: 'error',
        params: expect.objectContaining({ outcome: 'error', message: 'Element not found' }),
      }),
    );
  });

  it('never throws when there is no metricsLogger', () => {
    const c = { config: { get: () => ({ logging: { action_recording: true } }) } } as any;
    expect(() => recordAction(c, { type: 'wait' }, 1000, 'waited', null)).not.toThrow();
  });
});
