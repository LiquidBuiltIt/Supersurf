import { describe, it, expect } from 'vitest';
import { applyTabInfoUpdate, rehydrateAttachedTab } from '../src/backend/handlers';

describe('applyTabInfoUpdate', () => {
  it('rebuilds attachedTab from an update even when it was null (post-reconnect recovery)', () => {
    const mgr: any = { attachedTab: null };
    applyTabInfoUpdate(mgr, { id: 7, index: 2, title: 'X', url: 'https://ex.com/p', techStack: null });
    expect(mgr.attachedTab.url).toBe('https://ex.com/p');
    expect(mgr.attachedTab.id).toBe(7);
  });

  it('clears attachedTab when the update is null', () => {
    const mgr: any = { attachedTab: { id: 1, url: 'https://ex.com/' } };
    applyTabInfoUpdate(mgr, null);
    expect(mgr.attachedTab).toBeNull();
  });

  it('refreshes url on an already-attached tab (control)', () => {
    const mgr: any = { attachedTab: { id: 1, index: 0, title: 'old', url: 'https://ex.com/a' } };
    applyTabInfoUpdate(mgr, { id: 1, index: 0, title: 'new', url: 'https://ex.com/b' });
    expect(mgr.attachedTab.url).toBe('https://ex.com/b');
  });
});

describe('rehydrateAttachedTab', () => {
  it('repopulates attachedTab from the attached tab reported by getTabs', async () => {
    const mgr: any = { attachedTab: null };
    const client = {
      sendCmd: async () => ({
        attachedTabId: 9,
        tabs: [
          { id: 5, index: 0, title: 'A', url: 'https://a.com/', attached: false },
          { id: 9, index: 1, title: 'B', url: 'https://b.com/x', attached: true },
        ],
      }),
    };
    await rehydrateAttachedTab(mgr, client);
    expect(mgr.attachedTab.url).toBe('https://b.com/x');
    expect(mgr.attachedTab.id).toBe(9);
  });

  it('nulls attachedTab when no tab is attached', async () => {
    const mgr: any = { attachedTab: { id: 1, url: 'https://stale.com/' } };
    const client = { sendCmd: async () => ({ attachedTabId: null, tabs: [{ id: 5, url: 'https://a.com/', attached: false }] }) };
    await rehydrateAttachedTab(mgr, client);
    expect(mgr.attachedTab).toBeNull();
  });

  it('falls back to null when getTabs throws (graceful)', async () => {
    const mgr: any = { attachedTab: { id: 1, url: 'https://stale.com/' } };
    const client = { sendCmd: async () => { throw new Error('socket closed'); } };
    await rehydrateAttachedTab(mgr, client);
    expect(mgr.attachedTab).toBeNull();
  });
});
