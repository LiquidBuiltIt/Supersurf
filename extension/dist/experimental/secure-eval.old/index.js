/**
 * @module experimental/secure-eval/index
 *
 * Layer 2 of the secure_eval pipeline (runs in the Service Worker).
 * The server's Layer 1 (AST analysis via acorn) catches statically
 * detectable patterns. This layer catches dynamic/runtime access by
 * executing the agent's code against a deep Proxy membrane that has
 * no real DOM or browser APIs -- only traps that throw on blocked
 * property access.
 *
 * Flow: server AST check -> extension membrane check -> page execution.
 *
 * Key exports:
 * - {@link registerSecureEvalHandlers} — registers the `validateEval` command
 */
import { buildMembrane } from './membrane.js';
/**
 * Register the `validateEval` command handler.
 * A single membrane instance is reused across all validations (stateless Proxy).
 */
export function registerSecureEvalHandlers(wsConnection) {
    const membrane = buildMembrane();
    wsConnection.registerCommandHandler('validateEval', async (params) => {
        const code = params?.code;
        if (!code || !code.trim()) {
            return { safe: true };
        }
        try {
            // Sloppy-mode outer function enables `with(membrane)` to intercept all lookups.
            // Strict-mode IIFE inside prevents the agent code from escaping via `arguments.callee` etc.
            const wrapper = new Function('membrane', `with(membrane) { (function() { "use strict";\n${code}\n})(); }`);
            wrapper(membrane);
            // Code completed without hitting blocked terminals
            return { safe: true };
        }
        catch (err) {
            const message = err?.message || '';
            if (message.startsWith('[secure_eval:membrane]')) {
                // Code tried to access a blocked API
                return { safe: false, reason: message };
            }
            // SyntaxError or other runtime error — code can't reach dangerous APIs
            // through this path, so it's safe to let page execution handle it
            return { safe: true };
        }
    });
}
