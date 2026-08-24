import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import net from 'net';
import { ProfileRegistry } from '../../src/profiles/registry';
import { SessionRegistry } from '../../src/session';

describe('ProfileRegistry', () => {
  let tmpDir: string;
  let registry: ProfileRegistry;
  let sessions: SessionRegistry;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supersurf-test-profiles-'));
    registry = new ProfileRegistry(tmpDir);
    sessions = new SessionRegistry();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('create', () => {
    it('creates a profile with config file', () => {
      const config = registry.create('test-profile');
      expect(config.name).toBe('test-profile');
      expect(config.initialized).toBe(false);
      expect(config.created).toBeDefined();

      // Check files on disk
      const configPath = path.join(tmpDir, 'test-profile', 'supersurf.json');
      expect(fs.existsSync(configPath)).toBe(true);

      const chromeDataDir = path.join(tmpDir, 'test-profile', 'chrome-data');
      expect(fs.existsSync(chromeDataDir)).toBe(true);
    });

    it('creates a profile with experiment defaults', () => {
      const config = registry.create('with-experiments', { mouse_humanization: true, smart_waiting: true });
      expect(config.experiments).toEqual({ mouse_humanization: true, smart_waiting: true });
    });

    it('throws on duplicate profile', () => {
      registry.create('dupe');
      expect(() => registry.create('dupe')).toThrow("already exists");
    });
  });

  describe('name validation', () => {
    it('accepts valid names', () => {
      expect(() => registry.create('my-profile')).not.toThrow();
      expect(() => registry.create('scraper1')).not.toThrow();
      expect(() => registry.create('a')).not.toThrow();
    });

    it('rejects reserved names', () => {
      expect(() => registry.create('false')).toThrow('reserved');
      expect(() => registry.create('true')).toThrow('reserved');
      expect(() => registry.create('null')).toThrow('reserved');
    });

    it('rejects names with invalid characters', () => {
      expect(() => registry.create('My_Profile')).toThrow('Invalid profile name');
      expect(() => registry.create('has spaces')).toThrow('Invalid profile name');
      expect(() => registry.create('UPPER')).toThrow('Invalid profile name');
    });

    it('rejects leading hyphen', () => {
      expect(() => registry.create('-starts-with-hyphen')).toThrow('Invalid profile name');
    });

    it('rejects names longer than 32 characters', () => {
      const longName = 'a'.repeat(33);
      expect(() => registry.create(longName)).toThrow('Invalid profile name');
    });

    it('rejects empty name', () => {
      expect(() => registry.create('')).toThrow('required');
    });
  });

  describe('list', () => {
    it('returns empty array when no profiles', () => {
      expect(registry.list()).toEqual([]);
    });

    it('lists created profiles', () => {
      registry.create('alpha');
      registry.create('beta');
      const list = registry.list();
      expect(list).toHaveLength(2);
      expect(list.map(p => p.name).sort()).toEqual(['alpha', 'beta']);
      expect(list[0].running).toBe(false);
    });
  });

  describe('get', () => {
    it('returns config for existing profile', () => {
      registry.create('getter');
      const config = registry.get('getter');
      expect(config).not.toBeNull();
      expect(config!.name).toBe('getter');
    });

    it('returns null for non-existent profile', () => {
      expect(registry.get('nope')).toBeNull();
    });
  });

  describe('delete', () => {
    it('deletes a profile', () => {
      registry.create('deleteme');
      expect(registry.exists('deleteme')).toBe(true);
      registry.delete('deleteme', sessions);
      expect(registry.exists('deleteme')).toBe(false);
    });

    it('throws when profile not found', () => {
      expect(() => registry.delete('ghost', sessions)).toThrow('not found');
    });

    it('throws when active sessions are connected', () => {
      registry.create('active');
      sessions.add('s1', { writable: true } as net.Socket);
      sessions.setProfileId('s1', 'active');
      expect(() => registry.delete('active', sessions)).toThrow('active sessions are connected');
    });

    it('throws when a user-owned browser is running', () => {
      registry.create('user-owned');
      registry.setRunningPid('user-owned', process.pid, 'user');
      expect(() => registry.delete('user-owned', sessions)).toThrow('user-opened browser');
      expect(registry.exists('user-owned')).toBe(true);
    });

    it('deletes a profile with a daemon-owned browser running', () => {
      registry.create('daemon-owned');
      registry.setRunningPid('daemon-owned', 99999, 'daemon');
      registry.delete('daemon-owned', sessions);
      expect(registry.exists('daemon-owned')).toBe(false);
    });

    describe('refuseIfRunning (CLI failsafe — MCP profile_delete never sets this)', () => {
      it('refuses a daemon-owned running profile instead of killing it', () => {
        registry.create('daemon-owned');
        registry.setRunningPid('daemon-owned', process.pid, 'daemon');
        expect(() => registry.delete('daemon-owned', sessions, { refuseIfRunning: true }))
          .toThrow(/is running \(PID \d+\) — stop it first\./);
        expect(registry.exists('daemon-owned')).toBe(true);
      });

      it('refuses a user-owned running profile with the same message (not the user-opened-browser message)', () => {
        registry.create('user-owned');
        registry.setRunningPid('user-owned', process.pid, 'user');
        expect(() => registry.delete('user-owned', sessions, { refuseIfRunning: true }))
          .toThrow(/is running \(PID \d+\) — stop it first\./);
        expect(registry.exists('user-owned')).toBe(true);
      });

      it('deletes normally when not running', () => {
        registry.create('stopped');
        registry.delete('stopped', sessions, { refuseIfRunning: true });
        expect(registry.exists('stopped')).toBe(false);
      });

      it('still refuses on active sessions before checking running state', () => {
        registry.create('active');
        sessions.add('s1', { writable: true } as net.Socket);
        sessions.setProfileId('s1', 'active');
        expect(() => registry.delete('active', sessions, { refuseIfRunning: true }))
          .toThrow('active sessions are connected');
      });

      it('regression lock: default (no opts) behavior for MCP profile_delete is unchanged — kills a daemon-owned running browser and deletes', () => {
        registry.create('daemon-owned-default');
        registry.setRunningPid('daemon-owned-default', 99999, 'daemon');
        registry.delete('daemon-owned-default', sessions);
        expect(registry.exists('daemon-owned-default')).toBe(false);
      });

      it('regression lock: default (no opts) behavior still refuses a user-owned running browser with the original message', () => {
        registry.create('user-owned-default');
        registry.setRunningPid('user-owned-default', process.pid, 'user');
        expect(() => registry.delete('user-owned-default', sessions)).toThrow('user-opened browser');
        expect(registry.exists('user-owned-default')).toBe(true);
      });
    });
  });

  describe('rename', () => {
    it('renames a profile', () => {
      registry.create('old-name');
      const config = registry.rename('old-name', 'new-name', sessions);
      expect(config.name).toBe('new-name');
      expect(registry.exists('old-name')).toBe(false);
      expect(registry.exists('new-name')).toBe(true);
      expect(registry.get('new-name')!.name).toBe('new-name');
    });

    it('preserves initialized state and experiments across rename', () => {
      registry.create('src', { mouse_humanization: true });
      registry.markInitialized('src');
      const config = registry.rename('src', 'dst', sessions);
      expect(config.initialized).toBe(true);
      expect(config.experiments).toEqual({ mouse_humanization: true });
      expect(registry.isInitialized('dst')).toBe(true);
    });

    it('throws when the source profile does not exist', () => {
      expect(() => registry.rename('ghost', 'new-name', sessions)).toThrow('not found');
    });

    it('throws when the new name is invalid', () => {
      registry.create('src');
      expect(() => registry.rename('src', 'Invalid Name', sessions)).toThrow('Invalid profile name');
      expect(registry.exists('src')).toBe(true);
    });

    it('throws when the new name is already taken', () => {
      registry.create('src');
      registry.create('dst');
      expect(() => registry.rename('src', 'dst', sessions)).toThrow('already exists');
      expect(registry.exists('src')).toBe(true);
    });

    it('throws when active sessions are connected', () => {
      registry.create('active');
      sessions.add('s1', { writable: true } as net.Socket);
      sessions.setProfileId('s1', 'active');
      expect(() => registry.rename('active', 'renamed', sessions)).toThrow('active sessions are connected');
      expect(registry.exists('active')).toBe(true);
    });

    it('refuses while the profile is running', () => {
      registry.create('running');
      registry.setRunningPid('running', process.pid, 'daemon');
      expect(() => registry.rename('running', 'renamed', sessions)).toThrow(/is running \(PID \d+\)/);
      expect(registry.exists('running')).toBe(true);
      expect(registry.exists('renamed')).toBe(false);
    });

    it('succeeds once the running pid is stale (self-heals)', () => {
      registry.create('stale');
      registry.setRunningPid('stale', 999999999, 'daemon'); // certainly not alive
      registry.rename('stale', 'fresh', sessions);
      expect(registry.exists('stale')).toBe(false);
      expect(registry.exists('fresh')).toBe(true);
    });
  });

  describe('initialized', () => {
    it('marks profile as initialized', () => {
      registry.create('init-test');
      expect(registry.isInitialized('init-test')).toBe(false);
      registry.markInitialized('init-test');
      expect(registry.isInitialized('init-test')).toBe(true);
    });
  });

  describe('running PID tracking', () => {
    it('tracks running PIDs', () => {
      registry.create('runner');
      expect(registry.isRunning('runner')).toBe(false);

      registry.setRunningPid('runner', 99999);
      expect(registry.getRunningPid('runner')).toBe(99999);

      registry.clearRunningPid('runner');
      expect(registry.getRunningPid('runner')).toBeNull();
    });
  });

  describe('owner tracking', () => {
    it('defaults owner to daemon', () => {
      registry.setRunningPid('dev', process.pid);
      expect(registry.getOwner('dev')).toBe('daemon');
      expect(registry.isUserOwned('dev')).toBe(false);
    });

    it('records user ownership', () => {
      registry.setRunningPid('dev', process.pid, 'user');
      expect(registry.getOwner('dev')).toBe('user');
      expect(registry.isUserOwned('dev')).toBe(true);
    });

    it('returns null owner for a profile with no running pid', () => {
      expect(registry.getOwner('nope')).toBeNull();
    });

    it('clearRunningPid clears the owner too', () => {
      registry.setRunningPid('dev', process.pid, 'user');
      registry.clearRunningPid('dev');
      expect(registry.getOwner('dev')).toBeNull();
      expect(registry.isUserOwned('dev')).toBe(false);
    });

    it('hasUserOwnedRunning is true only while a live user-owned pid exists', () => {
      expect(registry.hasUserOwnedRunning()).toBe(false);
      registry.setRunningPid('a', process.pid, 'daemon');
      expect(registry.hasUserOwnedRunning()).toBe(false);
      registry.setRunningPid('b', process.pid, 'user');
      expect(registry.hasUserOwnedRunning()).toBe(true);
      registry.clearRunningPid('b');
      expect(registry.hasUserOwnedRunning()).toBe(false);
    });

    it('hasUserOwnedRunning drops dead user-owned pids', () => {
      registry.setRunningPid('dead', 999999999, 'user'); // certainly not alive
      expect(registry.hasUserOwnedRunning()).toBe(false);
      expect(registry.getOwner('dead')).toBeNull(); // stale entry was reaped
    });
  });
});
