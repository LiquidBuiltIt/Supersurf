/**
 * ProfileRegistry — CRUD for managed Chromium profiles.
 *
 * Each profile lives at ~/.supersurf/profiles/<name>/ with a supersurf.json
 * config file and a chrome-data/ directory for Chromium's --user-data-dir.
 *
 * @module profiles/registry
 */

import fs from 'fs';
import path from 'path';
import type { FileLogger } from 'shared';
import type { ProfileConfig } from './types';
import type { SessionRegistry } from '../session';

const debugLog = (...args: unknown[]) => {
  const logger = (global as any).DAEMON_LOGGER as FileLogger | undefined;
  if (logger) logger.log('[Profiles]', ...args);
  else if ((global as any).DAEMON_DEBUG) console.error('[Profiles]', ...args);
};

const RESERVED_NAMES = new Set(['false', 'true', 'null', '']);
const NAME_REGEX = /^[a-z0-9][a-z0-9-]{0,31}$/;

export class ProfileRegistry {
  private profilesDir: string;
  private runningPids: Map<string, number> = new Map();

  constructor(profilesDir: string) {
    this.profilesDir = profilesDir;
    fs.mkdirSync(profilesDir, { recursive: true });
  }

  /** Validate a profile name. Throws on invalid names. */
  private validateName(name: string): void {
    if (!name || typeof name !== 'string') {
      throw new Error('Profile name is required');
    }
    if (RESERVED_NAMES.has(name)) {
      throw new Error(`Profile name "${name}" is reserved`);
    }
    if (!NAME_REGEX.test(name)) {
      throw new Error(
        `Invalid profile name "${name}". Must be lowercase alphanumeric + hyphens, ` +
        `max 32 chars, no leading hyphen.`
      );
    }
  }

  /** Get the directory path for a profile. */
  private profileDir(name: string): string {
    return path.join(this.profilesDir, name);
  }

  /** Get the config file path for a profile. */
  private configPath(name: string): string {
    return path.join(this.profileDir(name), 'supersurf.json');
  }

  /** Create a new profile. */
  create(name: string, experiments?: Record<string, boolean>): ProfileConfig {
    this.validateName(name);

    if (this.exists(name)) {
      throw new Error(`Profile '${name}' already exists`);
    }

    const config: ProfileConfig = {
      name,
      created: new Date().toISOString(),
      initialized: false,
    };

    if (experiments && Object.keys(experiments).length > 0) {
      config.experiments = experiments;
    }

    const dir = this.profileDir(name);
    fs.mkdirSync(path.join(dir, 'chrome-data'), { recursive: true });
    fs.writeFileSync(this.configPath(name), JSON.stringify(config, null, 2), 'utf8');

    debugLog(`Profile created: "${name}"`);
    return config;
  }

  /** List all profiles with their running state. */
  list(): { name: string; created: string; running: boolean }[] {
    if (!fs.existsSync(this.profilesDir)) return [];

    const entries = fs.readdirSync(this.profilesDir, { withFileTypes: true });
    const result: { name: string; created: string; running: boolean }[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const config = this.get(entry.name);
      if (config) {
        result.push({
          name: config.name,
          created: config.created,
          running: this.isRunning(entry.name),
        });
      }
    }

    return result;
  }

  /** Get a profile's config by name. Returns null if not found. */
  get(name: string): ProfileConfig | null {
    const configFile = this.configPath(name);
    if (!fs.existsSync(configFile)) return null;
    try {
      return JSON.parse(fs.readFileSync(configFile, 'utf8'));
    } catch {
      return null;
    }
  }

  /** Delete a profile. Throws if active sessions are connected. */
  delete(name: string, sessions: SessionRegistry): void {
    if (!this.exists(name)) {
      throw new Error(`Profile '${name}' not found`);
    }

    const activeSessions = sessions.getSessionsForProfile(name);
    if (activeSessions.length > 0) {
      throw new Error(
        `Cannot delete profile '${name}' — active sessions are connected. ` +
        `Ask the user to disconnect those sessions first.`
      );
    }

    // Kill Chromium if running
    const pid = this.getRunningPid(name);
    if (pid !== null) {
      try {
        process.kill(pid, 'SIGTERM');
        debugLog(`Killed Chromium for profile "${name}" (pid ${pid})`);
      } catch {}
      this.clearRunningPid(name);
    }

    // Delete profile directory
    const dir = this.profileDir(name);
    fs.rmSync(dir, { recursive: true, force: true });
    debugLog(`Profile deleted: "${name}"`);
  }

  /** Check if a profile exists (directory + config file). */
  exists(name: string): boolean {
    return fs.existsSync(this.configPath(name));
  }

  /** Mark a profile as initialized (registration complete). */
  markInitialized(name: string): void {
    const config = this.get(name);
    if (!config) throw new Error(`Profile '${name}' not found`);
    config.initialized = true;
    fs.writeFileSync(this.configPath(name), JSON.stringify(config, null, 2), 'utf8');
    debugLog(`Profile "${name}" marked as initialized`);
  }

  /** Check if a profile has been initialized. */
  isInitialized(name: string): boolean {
    const config = this.get(name);
    return config?.initialized ?? false;
  }

  // ─── Running PID tracking (in-memory) ─────────────────────

  setRunningPid(name: string, pid: number): void {
    this.runningPids.set(name, pid);
  }

  clearRunningPid(name: string): void {
    this.runningPids.delete(name);
  }

  getRunningPid(name: string): number | null {
    return this.runningPids.get(name) ?? null;
  }

  isRunning(name: string): boolean {
    const pid = this.runningPids.get(name);
    if (pid === undefined) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      this.runningPids.delete(name);
      return false;
    }
  }
}
