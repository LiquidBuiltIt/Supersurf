/**
 * Secure Eval — AST-based static analysis for browser_evaluate code safety.
 *
 * Two of the three secure_eval defense layers live here (Layer 2 — the runtime
 * Proxy membrane — runs in the extension Service Worker, see
 * extension/src/security/secure-eval/). Both layers below execute server-side
 * before code is dispatched to the page:
 *
 * 1. **Server-side AST analysis** ({@link analyzeCode}): Parses code with acorn,
 *    walks the AST, and matches against a blocklist of dangerous patterns
 *    (network calls, storage access, code injection, obfuscation, prototype walking).
 *    Blocks code before it ever reaches the extension.
 *
 * 3. **Page-context Proxy wrapper** ({@link wrapWithPageProxy}): Wraps user code
 *    in a `with(proxy)` IIFE that intercepts blocked API access at runtime.
 *    Uses sloppy-mode outer for `with` statement, strict-mode inner for user code.
 *
 * Graduated from experiment in v1.11.0; opt out via `SUPERSURF_DISABLE_SECURE_EVAL=1`
 * or the `--disable-secure-eval` server CLI flag.
 *
 * @module tools/browser_evaluate/secure-eval
 *
 * Key exports:
 * - {@link analyzeCode} — static AST analysis, returns safe/blocked + reason
 * - {@link wrapWithPageProxy} — runtime Proxy wrapper for page-context execution
 * - {@link AnalysisResult} — analysis outcome type
 */
import { type AnalysisResult } from '../../security/analyzer';
/** Result of static code analysis — safe to execute or blocked with a reason.
 *  Re-exported from `security/analyzer` so this module's public API is unchanged. */
export type { AnalysisResult };
/**
 * Statically analyze JavaScript code for dangerous patterns.
 *
 * Parses with acorn in permissive mode (latest ECMAScript, module source type,
 * allow top-level return/await). Walks the AST with acorn-walk's ancestor
 * traversal to match against BLOCKED_PATTERNS. Returns on first violation.
 *
 * Unparseable code is considered safe — let Runtime.evaluate surface its own
 * syntax errors rather than blocking potentially valid code.
 *
 * @param code - JavaScript source code to analyze
 * @returns Analysis result: safe=true or safe=false with a reason string
 */
export declare function analyzeCode(code: string): AnalysisResult;
/**
 * Wrap user code in a page-context Proxy that intercepts blocked API access.
 * Returns a self-contained IIFE string ready for Runtime.evaluate.
 *
 * Architecture of the generated code:
 * - Creates a Proxy around `window` that intercepts all property access
 * - Global aliases (window, globalThis, self, etc.) redirect back to the proxy
 * - Sub-objects (document, navigator, location) get their own Proxy wrappers
 *   with per-object blocked properties and alias rules
 * - `has()` always returns true so `with(proxy)` captures every name lookup
 * - `getOwnPropertyDescriptor` returns throwing getters for blocked props
 * - Outer function is sloppy-mode (required for `with` statement)
 * - Inner function is strict-mode for the user code
 *
 * @param code - Raw JavaScript to wrap
 * @returns Self-contained IIFE string for Runtime.evaluate
 */
export declare function wrapWithPageProxy(code: string): string;
//# sourceMappingURL=secure-eval.d.ts.map