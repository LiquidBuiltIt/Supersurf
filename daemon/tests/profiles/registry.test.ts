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
});
