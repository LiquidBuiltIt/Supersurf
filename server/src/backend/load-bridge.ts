/**
 * Lazy loader for the BrowserBridge class. Loaded on first use, not at import time, for two reasons:
 *
 * 1. A static `import '../tools'` puts `tools.ts → tools/lib/dispatcher.ts:17 → tools/playbooks.ts:23 →
 *    playbooks/runner.ts:19 → backend.ts` into `backend`'s static closure: a cycle.
 * 2. `tools/screenshot.ts:22` imports `sharp` (native) statically, so a static import loads it at MCP boot.
 *
 * @module backend/load-bridge
 */

let BrowserBridge: typeof import('../tools').BrowserBridge | null = null;

export async function loadBrowserBridge(): Promise<typeof import('../tools').BrowserBridge> {
  if (!BrowserBridge) {
    const mod = await import('../tools');
    BrowserBridge = mod.BrowserBridge;
  }
  return BrowserBridge;
}
