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

describe('buildStatusHeader — playbook discovery hint', () => {
  const activeBase = {
    ...base,
    state: 'connected' as const,
    attachedTab: { id: 1, index: 0, url: 'https://github.com/' },
  };

  it('places the pre-rendered hint line on its own line before the divider', () => {
    const hint = '► 3 playbooks available: gh-create-repo, gh-login, gh-star | playbooks "list" for more details';
    const header = buildStatusHeader({ ...activeBase, playbookHint: hint });
    expect(header).toContain(`\n${hint}\n---\n\n`);
  });

  it('omits the hint line when playbookHint is null', () => {
    const header = buildStatusHeader({ ...activeBase, playbookHint: null });
    expect(header).not.toContain('playbooks available');
  });

  it('omits the hint line when playbookHint is not provided', () => {
    const header = buildStatusHeader({ ...activeBase });
    expect(header).not.toContain('playbooks available');
  });
});
