/**
 * Whether to skip SIGTERM on last MCP session disconnect.
 * - No pooled connection → false (fail closed; kill, since the feature is opt-in).
 * - Otherwise → only when the extension explicitly opted in (`=== true`).
 */
export declare function shouldKeepBrowserOnSessionEnd(conn: {
    keepBrowserOnSessionEnd?: boolean;
} | null | undefined): boolean;
export declare function applyKeepBrowserPreference(conn: {
    keepBrowserOnSessionEnd: boolean;
}, value: unknown): void;
//# sourceMappingURL=keep-browser.d.ts.map