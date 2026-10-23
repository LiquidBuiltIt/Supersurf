/**
 * Daemon CLI subcommands (`status`, `stop`, `observe`), argument parsing and
 * the daemon path constants. Moved out of main.ts; imports nothing from it,
 * so importing this module never reaches main.ts's entry block.
 *
 * @module cli-commands
 */
export declare const SUPERSURF_DIR: string;
export declare const PID_FILE: string;
export declare const SOCK_FILE: string;
export declare const LOG_FILE: string;
export declare function parseArgs(argv: string[]): {
    port: number;
    debug: boolean;
    verbose: boolean;
    command?: string;
    portExplicit: boolean;
};
/** Query the daemon over the Unix socket for live state. */
export declare function queryDaemonStatus(verbose: boolean): Promise<any>;
/** Format uptime seconds into human-readable string. */
export declare function formatUptime(seconds: number): string;
/** Read package version from package.json */
export declare function getVersion(): string;
export declare function printStatus(verbose: boolean): Promise<void>;
export declare function observe(): void;
/** Stop the running daemon by sending SIGTERM to the PID in the PID file. */
export declare function stopDaemon(): boolean;
//# sourceMappingURL=cli-commands.d.ts.map