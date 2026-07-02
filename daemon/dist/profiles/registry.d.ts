/**
 * ProfileRegistry — CRUD for managed Chromium profiles.
 *
 * Each profile lives at ~/.supersurf/profiles/<name>/ with a supersurf.json
 * config file and a chrome-data/ directory for Chromium's --user-data-dir.
 *
 * @module profiles/registry
 */
import type { ProfileConfig } from './types';
import type { SessionRegistry } from '../session';
export declare class ProfileRegistry {
    private profilesDir;
    private runningPids;
    private runningOwners;
    constructor(profilesDir: string);
    /** Validate a profile name. Throws on invalid names. */
    private validateName;
    /** Get the directory path for a profile. */
    private profileDir;
    /** Get the config file path for a profile. */
    private configPath;
    /** Create a new profile. */
    create(name: string, experiments?: Record<string, boolean>): ProfileConfig;
    /** List all profiles with their running state. */
    list(): {
        name: string;
        created: string;
        running: boolean;
    }[];
    /** Get a profile's config by name. Returns null if not found. */
    get(name: string): ProfileConfig | null;
    /** Delete a profile. Throws if active sessions are connected. */
    delete(name: string, sessions: SessionRegistry): void;
    /** Check if a profile exists (directory + config file). */
    exists(name: string): boolean;
    /** Mark a profile as initialized (registration complete). */
    markInitialized(name: string): void;
    /** Check if a profile has been initialized. */
    isInitialized(name: string): boolean;
    setRunningPid(name: string, pid: number, owner?: 'daemon' | 'user'): void;
    clearRunningPid(name: string): void;
    getRunningPid(name: string): number | null;
    /** Who spawned the running Chromium for this profile, or null if not running. */
    getOwner(name: string): 'daemon' | 'user' | null;
    /** True if the running Chromium for this profile was launched by the user (CLI). */
    isUserOwned(name: string): boolean;
    /** True if any profile has a live user-owned Chromium. */
    hasUserOwnedRunning(): boolean;
    isRunning(name: string): boolean;
}
//# sourceMappingURL=registry.d.ts.map