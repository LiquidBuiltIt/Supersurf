/**
 * `browser_evaluate` tool handler — runs JS in the page context with three-layer
 * `secure_eval` defense.
 *
 * Layer 1 (AST static analysis) and Layer 3 (page-context Proxy wrapper) live
 * in `./secure-eval`. Layer 2 (Service Worker membrane) lives extension-side
 * at `extension/src/security/secure-eval/`.
 *
 * `secure_eval` is on by default. Opt out by setting `security.secure_eval: false`
 * in `~/.supersurf/config.json` (and restarting the daemon), via the
 * `--disable-secure-eval` server CLI flag, or `SUPERSURF_DISABLE_SECURE_EVAL=1`.
 *
 * @module tools/browser_evaluate/index
 */
import type { ToolContext } from '../lib/types';
/**
 * Evaluate JavaScript in the page context.
 *
 * Three-layer defense pipeline (when `secure_eval` is enabled):
 * 1. **Static AST analysis** (~1ms): Blocks known dangerous patterns
 * 2. **Service Worker Proxy membrane** (~10–20ms): Extension-side validation
 * 3. **Page-context Proxy wrapper**: Runtime API access trapping
 *
 * @param args - `{ purpose: string, function?: string, expression?: string }`
 */
export declare function onEvaluate(ctx: ToolContext, args: any, options: any): Promise<any>;
//# sourceMappingURL=index.d.ts.map