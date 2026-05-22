import { describe, it, expect, beforeEach } from 'vitest';
import { DaemonExperimentRegistry } from '../src/experiments/index';

describe('DaemonExperimentRegistry', () => {
  let registry: DaemonExperimentRegistry;

  beforeEach(() => {
    registry = new DaemonExperimentRegistry();
  });

  // ── toggle ──────────────────────────────────────────────────

  describe('toggle()', () => {
    it('enables an experiment for a session', () => {
      registry.toggle('session-1', 'page_diffing', true);
      expect(registry.isEnabled('session-1', 'page_diffing')).toBe(true);
    });

    it('disables an experiment for a session', () => {
      registry.toggle('session-1', 'page_diffing', true);
      registry.toggle('session-1', 'page_diffing', false);
      expect(registry.isEnabled('session-1', 'page_diffing')).toBe(false);
    });

    it('returns the enabled value', () => {
      expect(registry.toggle('s', 'page_diffing', true)).toBe(true);
      expect(registry.toggle('s', 'page_diffing', false)).toBe(false);
    });

    it('throws on unknown experiment name', () => {
      expect(() => registry.toggle('s', 'warp_drive', true)).toThrow('Unknown experiment');
    });

    it('isolates state between sessions', () => {
      registry.toggle('session-a', 'page_diffing', true);
      registry.toggle('session-b', 'smart_waiting', true);

      expect(registry.isEnabled('session-a', 'page_diffing')).toBe(true);
      expect(registry.isEnabled('session-a', 'smart_waiting')).toBe(false);
      expect(registry.isEnabled('session-b', 'page_diffing')).toBe(false);
      expect(registry.isEnabled('session-b', 'smart_waiting')).toBe(true);
    });
  });

  // ── isEnabled ───────────────────────────────────────────────

  describe('isEnabled()', () => {
    it('returns false for untouched session with no defaults', () => {
      expect(registry.isEnabled('new-session', 'page_diffing')).toBe(false);
    });

    it('returns true after enabling', () => {
      registry.toggle('s', 'mouse_humanization', true);
      expect(registry.isEnabled('s', 'mouse_humanization')).toBe(true);
    });

    it('respects defaults from applyDefaults', () => {
      registry.applyDefaults(['page_diffing', 'smart_waiting']);
      expect(registry.isEnabled('fresh-session', 'page_diffing')).toBe(true);
      expect(registry.isEnabled('fresh-session', 'smart_waiting')).toBe(true);
      expect(registry.isEnabled('fresh-session', 'mouse_humanization')).toBe(false);
    });
  });

  // ── getAll ──────────────────────────────────────────────────

  describe('getAll()', () => {
    it('returns all experiments with correct states', () => {
      registry.toggle('s', 'page_diffing', true);
      registry.toggle('s', 'mouse_humanization', true);

      const states = registry.getAll('s');
      expect(states).toEqual({
        page_diffing: true,
        smart_waiting: false,
        storage_inspection: false,
        mouse_humanization: true,
      });
    });

    it('includes defaults for new sessions', () => {
      registry.applyDefaults(['smart_waiting']);
      const states = registry.getAll('new-session');
      expect(states.smart_waiting).toBe(true);
      expect(states.page_diffing).toBe(false);
    });

    it('returns all false for untouched session with no defaults', () => {
      const states = registry.getAll('empty');
      expect(Object.values(states).every(v => v === false)).toBe(true);
    });
  });

  // ── deleteSession ───────────────────────────────────────────

  describe('deleteSession()', () => {
    it('removes session state completely', () => {
      registry.toggle('s', 'page_diffing', true);
      registry.deleteSession('s');
      // After deletion, falls back to defaults (none set = false)
      expect(registry.isEnabled('s', 'page_diffing')).toBe(false);
    });

    it('subsequent getAll returns defaults for deleted session', () => {
      registry.applyDefaults(['smart_waiting']);
      registry.toggle('s', 'page_diffing', true);
      registry.toggle('s', 'smart_waiting', false); // override default

      registry.deleteSession('s');

      const states = registry.getAll('s');
      expect(states.page_diffing).toBe(false); // cleared
      expect(states.smart_waiting).toBe(true); // back to default
    });

    it('does not affect other sessions', () => {
      registry.toggle('a', 'page_diffing', true);
      registry.toggle('b', 'page_diffing', true);

      registry.deleteSession('a');

      expect(registry.isEnabled('a', 'page_diffing')).toBe(false);
      expect(registry.isEnabled('b', 'page_diffing')).toBe(true);
    });
  });

  // ── applyDefaults ───────────────────────────────────────────

  describe('applyDefaults()', () => {
    it('silently skips unknown experiment names', () => {
      expect(() => registry.applyDefaults(['warp_drive', 'page_diffing'])).not.toThrow();
      expect(registry.isEnabled('s', 'page_diffing')).toBe(true);
    });

    it('applies defaults to new sessions', () => {
      registry.applyDefaults(['page_diffing']);
      // New session inherits defaults
      const states = registry.getAll('new');
      expect(states.page_diffing).toBe(true);
    });

    it('does not affect already-initialized sessions', () => {
      registry.toggle('existing', 'smart_waiting', true);
      registry.applyDefaults(['page_diffing']);

      // Existing session retains its own state (no page_diffing)
      expect(registry.isEnabled('existing', 'page_diffing')).toBe(false);
      expect(registry.isEnabled('existing', 'smart_waiting')).toBe(true);
    });
  });

  // ── initSession ─────────────────────────────────────────────

  describe('initSession()', () => {
    it('copies defaults into session', () => {
      registry.applyDefaults(['page_diffing']);
      registry.initSession('s');
      expect(registry.isEnabled('s', 'page_diffing')).toBe(true);
    });

    it('is a no-op if session already initialized', () => {
      registry.applyDefaults(['page_diffing']);
      registry.initSession('s');
      registry.toggle('s', 'page_diffing', false);
      registry.initSession('s'); // should NOT reset
      expect(registry.isEnabled('s', 'page_diffing')).toBe(false);
    });
  });

  // ── isAvailable / listAvailable ─────────────────────────────

  describe('isAvailable()', () => {
    it('returns true for known experiments', () => {
      expect(registry.isAvailable('page_diffing')).toBe(true);
      expect(registry.isAvailable('mouse_humanization')).toBe(true);
    });

    it('returns false for unknown experiments', () => {
      expect(registry.isAvailable('warp_drive')).toBe(false);
    });

    it('returns false for graduated experiments', () => {
      expect(registry.isAvailable('secure_eval')).toBe(false); // graduated in v1.11.0
    });
  });

  describe('listAvailable()', () => {
    it('returns all 4 experiment names', () => {
      const available = registry.listAvailable();
      expect(available).toHaveLength(4);
      expect(available).toContain('page_diffing');
      expect(available).toContain('smart_waiting');
      expect(available).toContain('storage_inspection');
      expect(available).toContain('mouse_humanization');
      expect(available).not.toContain('secure_eval');
    });
  });

  // ── constructor(defaults) — config-injected snapshot ────────

  describe('constructor injection', () => {
    it('seeds defaults from an experiments snapshot', () => {
      const injected = new DaemonExperimentRegistry({
        defaults: {
          page_diffing: true,
          smart_waiting: false,
          storage_inspection: true,
          mouse_humanization: false,
        },
      });

      expect(injected.isEnabled('fresh', 'page_diffing')).toBe(true);
      expect(injected.isEnabled('fresh', 'storage_inspection')).toBe(true);
      expect(injected.isEnabled('fresh', 'smart_waiting')).toBe(false);
      expect(injected.isEnabled('fresh', 'mouse_humanization')).toBe(false);
    });

    it('regression lock: profiles is not a session-toggleable experiment (graduated)', () => {
      const reg = new DaemonExperimentRegistry();
      expect(reg.isAvailable('profiles')).toBe(false);
      expect(reg.listAvailable()).not.toContain('profiles');
      // Injecting `profiles: true` via the snapshot is silently dropped — the
      // type definition no longer carries the key, so the cast is necessary.
      const injected = new DaemonExperimentRegistry({
        defaults: { page_diffing: false, smart_waiting: false, storage_inspection: false, mouse_humanization: false, profiles: true } as any,
      });
      const states = injected.getAll('any-session');
      expect((states as any).profiles).toBeUndefined();
    });

    it('no defaults when constructed with empty options', () => {
      const empty = new DaemonExperimentRegistry();
      expect(empty.isEnabled('s', 'page_diffing')).toBe(false);
    });
  });
});
