/**
 * Chromium process management — binary discovery, spawning, and PID tracking.
 *
 * @module profiles/chrome
 */
import { type ChildProcess } from 'child_process';
import type { PidLogEntry } from './types';
/**
 * Find the Chromium binary on the system.
 * Checks known paths, then falls back to `which chromium`.
 */
export declare function findChromiumBinary(): string | null;
/**
 * Spawn a Chromium instance for a managed profile.
 *
 * @param profileName - Profile name (used for user-data-dir path)
 * @param extensionDir - Path to the cached extension directory
 * @param port - Daemon port (for registration URL)
 * @param isFirstLaunch - If true, opens the registration URL as startup page
 * @returns The spawned ChildProcess
 */
export declare function spawnChromium(profileName: string, extensionDir: string, port: number, isFirstLaunch: boolean): ChildProcess;
/** Append a single entry to the PID log file. */
export declare function appendPidLog(entry: PidLogEntry): void;
/** Read and parse all entries from the PID log file. */
export declare function replayPidLog(): PidLogEntry[];
/** Replay spawn/kill events to find orphan PIDs (spawned but never killed). */
export declare function findOrphanPids(entries: PidLogEntry[]): number[];
/** Kill orphan Chromium processes and log kill events. */
export declare function killOrphanPids(pids: number[]): void;
/** Truncate the PID log file after cleanup. */
export declare function truncatePidLog(): void;
//# sourceMappingURL=chrome.d.ts.map