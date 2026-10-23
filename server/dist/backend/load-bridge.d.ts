/**
 * Lazy loader for the BrowserBridge class. Loaded on first use, not at import time, for two reasons:
 *
 * 1. A static `import '../tools'` puts `tools.ts → tools/lib/dispatcher.ts:17 → tools/playbooks.ts:23 →
 *    playbooks/runner.ts:18 → backend.ts` into `backend`'s static closure: a cycle.
 * 2. `tools/screenshot.ts:22` imports `sharp` (native) statically, so a static import loads it at MCP boot.
 *
 * @module backend/load-bridge
 */
export declare function loadBrowserBridge(): Promise<typeof import('../tools').BrowserBridge>;
//# sourceMappingURL=load-bridge.d.ts.map