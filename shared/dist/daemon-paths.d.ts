/** `~/.supersurf` */
export declare function supersurfDir(): string;
/** Daemon Unix socket: `~/.supersurf/daemon.sock` */
export declare function sockPath(): string;
/** Daemon pidfile: `~/.supersurf/daemon.pid` */
export declare function pidPath(): string;
/** PID from the pidfile, or null when it is missing, unreadable or not an integer. */
export declare function readDaemonPid(): number | null;
/** True when a process with this PID exists (signal 0 probe). */
export declare function isProcessAlive(pid: number): boolean;
/** True when the pidfile names a live process. */
export declare function isDaemonRunning(): boolean;
//# sourceMappingURL=daemon-paths.d.ts.map