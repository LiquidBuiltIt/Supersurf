/**
 * Whether to skip SIGTERM on last MCP session disconnect.
 * - No pooled connection → true (do not kill; preference unknown).
 * - Otherwise → only when the extension explicitly opted in (`=== true`).
 */
export declare function shouldKeepBrowserOnSessionEnd(conn: {
    keepBrowserOnSessionEnd?: boolean;
} | null | undefined): boolean;
export declare function applyKeepBrowserPreference(conn: {
    keepBrowserOnSessionEnd: boolean;
}, value: unknown): void;
//# sourceMappingURL=keep-browser.d.ts.map