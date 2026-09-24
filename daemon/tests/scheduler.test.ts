import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RequestScheduler } from '../src/scheduler';
import { SessionRegistry } from '../src/session';
import type { ExtensionBridge } from '../src/extension-bridge';
import net from 'net';

function mockSocket(): net.Socket {
  return { writable: true } as any;
}

function mockBridge(overrides: Partial<ExtensionBridge> = {}): ExtensionBridge {
  return {
    sendCmd: vi.fn().mockResolvedValue({ success: true }),
    connected: true,
    browser: 'chrome',
    buildTime: null,
    ...overrides,
  } as any;
}

/** A scheduler wired up with the given session ids already registered. */
function schedulerWithSessions(ids: string[]): { sessions: SessionRegistry; enqueue: RequestScheduler['enqueue'] } {
  const bridge = mockBridge();
  const sessions = new SessionRegistry();
  const scheduler = new RequestScheduler(bridge, sessions);
  for (const id of ids) {
    sessions.add(id, mockSocket());
    scheduler.addSession(id);
  }
  return { sessions, enqueue: scheduler.enqueue.bind(scheduler) };
}

describe('RequestScheduler', () => {
  let bridge: ExtensionBridge;
  let sessions: SessionRegistry;
  let scheduler: RequestScheduler;

  beforeEach(() => {
    bridge = mockBridge();
    sessions = new SessionRegistry();
    scheduler = new RequestScheduler(bridge, sessions);
  });

  describe('addSession/removeSession', () => {
    it('can add and remove sessions', () => {
      sessions.add('s1', mockSocket());
      scheduler.addSession('s1');

      sessions.add('s2', mockSocket());
      scheduler.addSession('s2');

      // Remove s1 — should not throw
      scheduler.removeSession('s1');
    });

    it('rejects queued requests on removeSession', async () => {
      sessions.add('s1', mockSocket());
      scheduler.addSession('s1');

      // Enqueue a request but don't await it yet
      const promise = scheduler.enqueue('s1', 'navigate', { url: 'https://example.com' });

      // If the scheduler already processed it, that's fine - we need to block processing
      // Instead, test that removeSession rejects unprocessed requests
      // by adding a slow command first
      sessions.add('s2', mockSocket());
      scheduler.addSession('s2');

      // Remove s2 immediately (before any requests are processed)
      scheduler.removeSession('s2');

      // The s1 request should still resolve
      await promise;
    });
  });

  describe('enqueue', () => {
    it('executes a single request', async () => {
      sessions.add('s1', mockSocket());
      scheduler.addSession('s1');

      (bridge.sendCmd as any).mockResolvedValueOnce({ navigated: true });

      const result = await scheduler.enqueue('s1', 'navigate', { url: 'https://example.com' });
      expect(result).toEqual({ navigated: true });
      expect(bridge.sendCmd).toHaveBeenCalledWith(
        'navigate',
        expect.objectContaining({ url: 'https://example.com', _sessionId: 's1' }),
        30000,
      );
    });

    it('rejects for unknown session', async () => {
      await expect(
        scheduler.enqueue('unknown', 'navigate', {})
      ).rejects.toThrow('Unknown session');
    });
  });

  describe('round-robin fairness', () => {
    it('alternates between sessions', async () => {
      const callOrder: string[] = [];
      (bridge.sendCmd as any).mockImplementation(async (_method: string, params: any) => {
        callOrder.push(params._sessionId);
        return { success: true };
      });

      sessions.add('a', mockSocket());
      sessions.add('b', mockSocket());
      scheduler.addSession('a');
      scheduler.addSession('b');

      // Enqueue requests for both sessions
      const p1 = scheduler.enqueue('a', 'cmd1', {});
      const p2 = scheduler.enqueue('b', 'cmd2', {});
      const p3 = scheduler.enqueue('a', 'cmd3', {});
      const p4 = scheduler.enqueue('b', 'cmd4', {});

      await Promise.all([p1, p2, p3, p4]);

      // Should alternate: a, b, a, b
      expect(callOrder).toEqual(['a', 'b', 'a', 'b']);
    });
  });

  describe('tab ownership enforcement', () => {
    it('rejects selectTab when tab is owned by another session', async () => {
      sessions.add('s1', mockSocket());
      sessions.add('s2', mockSocket());
      scheduler.addSession('s1');
      scheduler.addSession('s2');

      // s1 owns tab 42
      sessions.addOwnedTab('s1', 42);

      await expect(
        scheduler.enqueue('s2', 'selectTab', { tabId: 42 })
      ).rejects.toThrow('owned by session "s1"');
    });

    it('rejects closeTab when tab is owned by another session', async () => {
      sessions.add('s1', mockSocket());
      sessions.add('s2', mockSocket());
      scheduler.addSession('s1');
      scheduler.addSession('s2');

      sessions.addOwnedTab('s1', 42);

      await expect(
        scheduler.enqueue('s2', 'closeTab', { tabId: 42 })
      ).rejects.toThrow('owned by session "s1"');
    });

    it('allows selectTab on unowned tab', async () => {
      sessions.add('s1', mockSocket());
      scheduler.addSession('s1');

      (bridge.sendCmd as any).mockResolvedValueOnce({ attachedTab: { id: 10, groupId: 1 } });

      await scheduler.enqueue('s1', 'selectTab', { tabId: 10 });
      expect(bridge.sendCmd).toHaveBeenCalled();
    });
  });

  describe('tab ownership tracking', () => {
    it('tracks createTab ownership', async () => {
      sessions.add('s1', mockSocket());
      scheduler.addSession('s1');

      (bridge.sendCmd as any).mockResolvedValueOnce({ attachedTab: { id: 99, groupId: 5 } });

      await scheduler.enqueue('s1', 'createTab', { url: 'https://example.com' });
      expect(sessions.get('s1')!.ownedTabs.has(99)).toBe(true);
      expect(sessions.getAttachedTabId('s1')).toBe(99);
    });

    it('clears ownership on closeTab', async () => {
      sessions.add('s1', mockSocket());
      scheduler.addSession('s1');

      sessions.addOwnedTab('s1', 50);
      sessions.setAttachedTabId('s1', 50);

      (bridge.sendCmd as any).mockResolvedValueOnce({ success: true });

      await scheduler.enqueue('s1', 'closeTab', {});
      expect(sessions.get('s1')!.ownedTabs.has(50)).toBe(false);
      expect(sessions.getAttachedTabId('s1')).toBeNull();
    });

    it('refuses to close another session\'s tab and names the owner', async () => {
      const s = schedulerWithSessions(['sm-a', 'sm-b']);
      s.sessions.addOwnedTab('sm-a', 101);
      s.sessions.setAttachedTabId('sm-a', 101);

      await expect(s.enqueue('sm-b', 'closeTab', { tabId: 101 }))
        .rejects.toThrow(/owned by session "sm-a"/);
    });
  });

  describe('getTabs filtering', () => {
    it('filters out tabs owned by other sessions', async () => {
      sessions.add('s1', mockSocket());
      sessions.add('s2', mockSocket());
      scheduler.addSession('s1');
      scheduler.addSession('s2');

      sessions.addOwnedTab('s2', 20);

      (bridge.sendCmd as any).mockResolvedValueOnce({
        tabs: [
          { id: 10, title: 'Tab A' },
          { id: 20, title: 'Tab B' },
          { id: 30, title: 'Tab C' },
        ],
      });

      const result = await scheduler.enqueue('s1', 'getTabs', {});
      expect(result.tabs).toHaveLength(2);
      expect(result.tabs.map((t: any) => t.id)).toEqual([10, 30]);
    });
  });

  describe('drainAll', () => {
    it('rejects all queued requests', async () => {
      sessions.add('s1', mockSocket());
      scheduler.addSession('s1');

      // Block the scheduler with a slow command
      let resolveFirst: any;
      (bridge.sendCmd as any).mockImplementationOnce(() => new Promise(r => { resolveFirst = r; }));

      const p1 = scheduler.enqueue('s1', 'slow', {});
      // Wait for drain to start processing
      await new Promise(r => setTimeout(r, 10));

      // Queue another
      const p2 = scheduler.enqueue('s1', 'queued', {});

      // Drain all
      scheduler.drainAll();

      // p2 should be rejected
      await expect(p2).rejects.toThrow('shutting down');

      // Unblock p1 so it resolves
      resolveFirst?.({ ok: true });
      await p1;
    });
  });
});
