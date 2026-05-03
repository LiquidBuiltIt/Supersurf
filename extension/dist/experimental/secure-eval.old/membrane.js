/**
 * @module experimental/secure-eval/membrane
 *
 * Constructs a deep recursive Proxy that simulates a permissive object graph
 * (property chains, function calls) but throws immediately when code touches
 * a blocked terminal (e.g. `fetch`, `eval`, `localStorage`).
 *
 * Used inside a `with(membrane) { ... }` block so that every unqualified
 * identifier lookup in agent code is intercepted by the Proxy's `has` trap.
 *
 * Key exports:
 * - {@link buildMembrane} — factory that returns the root Proxy
 */
/**
 * Property names that trigger an immediate throw when accessed.
 * Covers network I/O, code injection, storage, and navigation escape hatches.
 */
const BLOCKED_TERMINALS = new Set([
    'fetch', 'eval', 'atob', 'btoa',
    'localStorage', 'sessionStorage',
    'Function', 'WebSocket', 'XMLHttpRequest', 'EventSource', 'Image',
    'Worker', 'SharedWorker', 'RTCPeerConnection',
    'sendBeacon', 'cookie', 'importScripts', 'open', 'defaultView',
    'write', 'writeln', 'assign', 'replace',
    // Prototype chain walking & reflection escapes
    'constructor', '__proto__', 'globalThis', 'Reflect', 'Proxy',
    'getPrototypeOf', 'setPrototypeOf', 'defineProperty',
]);
/**
 * Build a recursive Proxy membrane.
 * Any property access that reaches a blocked terminal throws.
 * Non-blocked access returns another Proxy (infinite depth).
 * @param blocked - Set of property names that trigger rejection (defaults to {@link BLOCKED_TERMINALS})
 * @returns Root Proxy object to use as the `with` scope
 */
export function buildMembrane(blocked = BLOCKED_TERMINALS) {
    /**
     * Recursively create Proxy nodes. The target is a bare function so that
     * the `apply` trap works (Proxy apply only triggers on function targets).
     */
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
                // Always return true so `with(membrane)` intercepts every identifier lookup
                // instead of falling through to the outer scope (where real globals live)
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
