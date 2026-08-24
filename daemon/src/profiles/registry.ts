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
  private runningOwners: Map<string, 'daemon' | 'user'> = new Map();

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

  /**
   * Delete a profile. Throws if active sessions are connected.
   *
   * Default behavior (MCP `profile_delete` tool — unchanged): if the profile's
   * Chromium is daemon-owned and running, it's killed and deletion proceeds; a
   * user-owned running browser blocks deletion. Pass `refuseIfRunning: true`
   * (the CLI's `profiles rm` does) to refuse outright — regardless of owner —
   * instead of killing anything, matching `rename`'s failsafe. Enforced here,
   * server-side, so the check can't race a concurrent spawn/kill.
   */
  delete(name: string, sessions: SessionRegistry, opts: { refuseIfRunning?: boolean } = {}): void {
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

    if (opts.refuseIfRunning && this.isRunning(name)) {
      const pid = this.getRunningPid(name);
      throw new Error(`Profile '${name}' is running (PID ${pid}) — stop it first.`);
    }

    // Kill Chromium if running
    const pid = this.getRunningPid(name);
    if (pid !== null) {
      if (this.isUserOwned(name)) {
        throw new Error(`Profile '${name}' has a user-opened browser running. Close the browser window first, then delete the profile.`);
      }
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

  /**
   * Rename a profile. Throws if active sessions are connected or the profile's
   * Chromium is currently running — same failsafe as `delete`, but never kills
   * the browser itself (unlike delete's daemon-owned auto-kill): a rename must
   * be refused outright, not raced against a live process.
   */
  rename(oldName: string, newName: string, sessions: SessionRegistry): ProfileConfig {
    if (!this.exists(oldName)) {
      throw new Error(`Profile '${oldName}' not found`);
    }
    this.validateName(newName);
    if (this.exists(newName)) {
      throw new Error(`Profile '${newName}' already exists`);
    }

    const activeSessions = sessions.getSessionsForProfile(oldName);
    if (activeSessions.length > 0) {
      throw new Error(
        `Cannot rename profile '${oldName}' — active sessions are connected. ` +
        `Ask the user to disconnect those sessions first.`
      );
    }

    if (this.isRunning(oldName)) {
      const pid = this.getRunningPid(oldName);
      throw new Error(`Profile '${oldName}' is running (PID ${pid}) — stop it first.`);
    }

    const config = this.get(oldName)!;
    config.name = newName;

    fs.renameSync(this.profileDir(oldName), this.profileDir(newName));
    fs.writeFileSync(this.configPath(newName), JSON.stringify(config, null, 2), 'utf8');

    debugLog(`Profile renamed: "${oldName}" -> "${newName}"`);
    return config;
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

  setRunningPid(name: string, pid: number, owner: 'daemon' | 'user' = 'daemon'): void {
    this.runningPids.set(name, pid);
    this.runningOwners.set(name, owner);
  }

  clearRunningPid(name: string): void {
    this.runningPids.delete(name);
    this.runningOwners.delete(name);
  }

  getRunningPid(name: string): number | null {
    return this.runningPids.get(name) ?? null;
  }

  /** Who spawned the running Chromium for this profile, or null if not running. */
  getOwner(name: string): 'daemon' | 'user' | null {
    return this.runningOwners.get(name) ?? null;
  }

  /** True if the running Chromium for this profile was launched by the user (CLI). */
  isUserOwned(name: string): boolean {
    return this.runningOwners.get(name) === 'user';
  }

  /** True if any profile has a live user-owned Chromium. */
  hasUserOwnedRunning(): boolean {
    for (const [name, owner] of [...this.runningOwners.entries()]) {
      if (owner === 'user' && this.isRunning(name)) return true;
    }
    return false;
  }

  isRunning(name: string): boolean {
    const pid = this.runningPids.get(name);
    if (pid === undefined) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      this.clearRunningPid(name);
      return false;
    }
  }
}
