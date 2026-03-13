import { describe, it, expect, beforeEach } from 'vitest';
import { SessionRegistry } from '../src/session';
import net from 'net';

function mockSocket(): net.Socket {
  return { writable: true } as any;
}

describe('SessionRegistry', () => {
  let registry: SessionRegistry;

  beforeEach(() => {
    registry = new SessionRegistry();
  });

  describe('add/remove', () => {
    it('adds a new session', () => {
      expect(registry.add('s1', mockSocket())).toBe(true);
      expect(registry.has('s1')).toBe(true);
      expect(registry.count).toBe(1);
    });

    it('rejects duplicate session IDs', () => {
      registry.add('s1', mockSocket());
      expect(registry.add('s1', mockSocket())).toBe(false);
      expect(registry.count).toBe(1);
    });

    it('removes a session', () => {
      registry.add('s1', mockSocket());
      const removed = registry.remove('s1');
      expect(removed).toBeDefined();
      expect(removed!.sessionId).toBe('s1');
      expect(registry.has('s1')).toBe(false);
      expect(registry.count).toBe(0);
    });

    it('returns undefined for non-existent remove', () => {
      expect(registry.remove('nope')).toBeUndefined();
    });
  });

  describe('get/ids/values', () => {
    it('gets a session by ID', () => {
      const sock = mockSocket();
      registry.add('s1', sock);
      const session = registry.get('s1');
      expect(session).toBeDefined();
      expect(session!.sessionId).toBe('s1');
      expect(session!.socket).toBe(sock);
    });

    it('returns undefined for missing session', () => {
      expect(registry.get('missing')).toBeUndefined();
    });

    it('lists session IDs', () => {
      registry.add('a', mockSocket());
      registry.add('b', mockSocket());
      expect(registry.ids()).toEqual(['a', 'b']);
    });

    it('iterates values', () => {
      registry.add('x', mockSocket());
      registry.add('y', mockSocket());
      const ids = [...registry.values()].map(s => s.sessionId);
      expect(ids).toEqual(['x', 'y']);
    });
  });

  describe('tab ownership', () => {
    beforeEach(() => {
      registry.add('s1', mockSocket());
      registry.add('s2', mockSocket());
    });

    it('tracks attached tab ID', () => {
      expect(registry.getAttachedTabId('s1')).toBeNull();
      registry.setAttachedTabId('s1', 42);
      expect(registry.getAttachedTabId('s1')).toBe(42);
    });

    it('sets group ID', () => {
      registry.setGroupId('s1', 7);
      expect(registry.get('s1')!.groupId).toBe(7);
    });

    it('adds and removes owned tabs', () => {
      registry.addOwnedTab('s1', 10);
      registry.addOwnedTab('s1', 20);
      expect(registry.get('s1')!.ownedTabs).toEqual(new Set([10, 20]));

      registry.removeOwnedTab('s1', 10);
      expect(registry.get('s1')!.ownedTabs).toEqual(new Set([20]));
    });

    it('finds tab owner', () => {
      registry.addOwnedTab('s1', 10);
      registry.addOwnedTab('s2', 20);
      expect(registry.findTabOwner(10)).toBe('s1');
      expect(registry.findTabOwner(20)).toBe('s2');
      expect(registry.findTabOwner(99)).toBeNull();
    });

    it('gets other owned tab IDs', () => {
      registry.addOwnedTab('s1', 10);
      registry.addOwnedTab('s1', 11);
      registry.addOwnedTab('s2', 20);
      const others = registry.getOtherOwnedTabIds('s1');
      expect(others).toEqual(new Set([20]));
    });
  });

  describe('profile tracking', () => {
    beforeEach(() => {
      registry.add('s1', mockSocket());
      registry.add('s2', mockSocket());
    });

    it('defaults profileId to null', () => {
      expect(registry.getProfileId('s1')).toBeNull();
    });

    it('sets and gets profileId', () => {
      registry.setProfileId('s1', 'scraper');
      expect(registry.getProfileId('s1')).toBe('scraper');
    });

    it('gets sessions for a profile', () => {
      registry.setProfileId('s1', 'scraper');
      registry.setProfileId('s2', 'scraper');
      const sessions = registry.getSessionsForProfile('scraper');
      expect(sessions).toHaveLength(2);
      expect(sessions.map(s => s.sessionId).sort()).toEqual(['s1', 's2']);
    });

    it('returns empty array for unmatched profile', () => {
      expect(registry.getSessionsForProfile('unknown')).toEqual([]);
    });
  });

  describe('no-ops on missing sessions', () => {
    it('setAttachedTabId on missing session does nothing', () => {
      registry.setAttachedTabId('nope', 1);
      expect(registry.getAttachedTabId('nope')).toBeNull();
    });

    it('addOwnedTab on missing session does nothing', () => {
      registry.addOwnedTab('nope', 1); // should not throw
    });
  });
});
