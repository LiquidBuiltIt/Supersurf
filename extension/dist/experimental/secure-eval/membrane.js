/**
 * Deep Proxy membrane for secure_eval Layer 2.
 * Builds a recursive Proxy that traps access to blocked API terminals.
 * Used inside the Service Worker to sandbox code without real DOM/APIs.
 */
const BLOCKED_TERMINALS = new Set([
    'fetch', 'eval', 'atob', 'btoa',
    'localStorage', 'sessionStorage',
    'Function', 'WebSocket', 'XMLHttpRequest', 'EventSource',
    'sendBeacon', 'cookie', 'importScripts', 'open', 'defaultView',
]);
/**
 * Build a recursive Proxy membrane.
 * Any property access that reaches a blocked terminal throws.
 * Non-blocked access returns another Proxy (infinite depth).
 */
export function buildMembrane(blocked = BLOCKED_TERMINALS) {
    function makeProxy(path = '') {
        return new Proxy(function () { }, {
            get(_target, prop) {
                if (typeof prop === 'symbol')
                    return undefined;
                const fullPath = path ? `${path}.${prop}` : prop;
                if (blocked.has(prop)) {
                    throw new Error(`[secure_eval:membrane] Blocked: ${fullPath}`);
                }
                return makeProxy(fullPath);
            },
            has(_target, prop) {
                // Return true for all props — forces `with` to intercept every lookup
                return true;
            },
            set(_target, prop, _value) {
                if (typeof prop === 'symbol')
                    return true;
                const fullPath = path ? `${path}.${prop}` : prop;
                if (blocked.has(prop)) {
                    throw new Error(`[secure_eval:membrane] Blocked: ${fullPath}`);
                }
                return true;
            },
            apply(_target, _thisArg, _args) {
                // Intermediate calls (e.g. querySelector()) return another proxy
                return makeProxy(path);
            },
            ownKeys(_target) {
                // Only expose 'prototype' (required by Proxy invariant for function targets)
                return ['prototype'];
            },
            getOwnPropertyDescriptor(_target, prop) {
                if (typeof prop === 'symbol')
                    return undefined;
                // Delegate 'prototype' to real target (non-configurable — Proxy invariant)
                if (prop === 'prototype')
                    return Object.getOwnPropertyDescriptor(_target, prop);
                const fullPath = path ? `${path}.${prop}` : prop;
                if (blocked.has(prop)) {
                    throw new Error(`[secure_eval:membrane] Blocked: ${fullPath}`);
                }
                return { configurable: true, enumerable: true, value: makeProxy(fullPath) };
            },
        });
    }
    return makeProxy();
}
