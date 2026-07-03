/**
 * Chromium process management — binary discovery, spawning, and PID tracking.
 *
 * @module profiles/chrome
 */
import { type ChildProcess } from 'child_process';
import type { PidLogEntry } from './types';
/**
 * Return true if the binary resolves to a path under /snap/.
 * Snap confinement blocks access to ~/.supersurf/ via AppArmor's home interface
 * (which excludes hidden directories), so Snap-packaged Chromium cannot run
 * managed profiles even though the binary itself launches fine.
 */
export declare function isSnapBinary(binPath: string): boolean;
/**
 * Find a usable Chromium-family binary on the system.
 * Prefers non-Snap binaries — Snap-confined Chromium cannot access ~/.supersurf/.
 */
export declare function findChromiumBinary(): string | null;
/** True when the only Chromium-family binaries on the system are Snap-confined. */
export declare function isSnapOnlySystem(): boolean;
/** Optional Chromium spawn flags resolved from ConfigService. */
export interface StartupOpts {
    disableGpu?: boolean;
}
/**
 * Spawn a Chromium instance for a managed profile.
 *
 * @param profileName - Profile name (used for user-data-dir path)
 * @param extensionDir - Path to the cached extension directory
 * @param port - Daemon port (for registration URL)
 * @param openRegistration - If true, opens the profile registration URL as the
 *   startup page. This re-arms the profile binding in the extension's
 *   chrome.storage.local on every spawn — not just the first — so an
 *   already-initialized profile whose storage lost `supersurf_profile`
 *   (force-kill, rsync'd profile, Chrome corruption) can still recover.
 * @param startupOpts - Optional Chromium flags from config (e.g. disableGpu for stability)
 * @returns The spawned ChildProcess
 */
export declare function spawnChromium(profileName: string, extensionDir: string, port: number, openRegistration: boolean, startupOpts?: StartupOpts): ChildProcess;
/** Append a single entry to the PID log file. */
export declare function appendPidLog(entry: PidLogEntry): void;
/** Read and parse all entries from the PID log file. */
export declare function replayPidLog(): PidLogEntry[];
/**
 * Replay spawn/kill events to find orphan PIDs (spawned but never killed).
 * User-owned spawns (`owner: 'user'`) are excluded — the daemon never reaps
 * a browser the human opened; they close it themselves.
 */
export declare function findOrphanPids(entries: PidLogEntry[]): number[];
/** Kill orphan Chromium processes and log kill events. */
export declare function killOrphanPids(pids: number[]): void;
/** Truncate the PID log file after cleanup. */
export declare function truncatePidLog(): void;
//# sourceMappingURL=chrome.d.ts.map