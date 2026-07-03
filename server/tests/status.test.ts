import { describe, it, expect } from 'vitest';
import { buildStatusHeader } from '../src/backend/status';
import type { BackendConfig } from '../src/backend/types';

const config = { server: { name: 'supersurf', version: '9.9.9' } } as BackendConfig;

const base = {
  config,
  debugMode: false,
  connectedBrowserName: null,
  attachedTab: null,
  stealthMode: false,
  extensionServer: null,
};

describe('buildStatusHeader — passive state surfaces last connect failure', () => {
  it('shows a bare Disabled line when there is no prior failure', () => {
    const header = buildStatusHeader({ ...base, state: 'passive' });
    expect(header).toContain('🔴 v9.9.9 | Disabled');
    expect(header).not.toContain('Last connect failed');
  });

  // Regression for Bug 2(b): a wedged daemon used to leave `status` reporting a
  // bare cached "Disabled" with no hint at the real cause. The passive header
  // must now surface the captured connect-failure reason (e.g. EADDRINUSE).
  it('surfaces the last connect failure reason when set', () => {
    const reason = 'port 5555 is already in use (EADDRINUSE)';
    const header = buildStatusHeader({ ...base, state: 'passive', lastConnectError: reason });
    expect(header).toContain('⚠️ Last connect failed:');
    expect(header).toContain(reason);
    expect(header).toContain('🔴 v9.9.9 | Disabled');
  });
});
