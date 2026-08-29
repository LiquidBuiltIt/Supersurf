"use strict";
/**
 * The `supersurf` object a playbook script sees.
 *
 * PERMISSION BY CONSTRUCTION: a method whose permission is not declared in
 * `meta.permissions` is NOT BUILT. There is no runtime check, no "permission
 * denied" throw, nothing to bypass — the property does not exist. Do not
 * replace this with a guard clause.
 *
 * The client is also the ONE place two client-level reshapes happen (spec §7.7):
 *   - `see*` resolves to a boolean instead of a payload
 *   - the `{ success: false, error }` failure envelope becomes a thrown Error
 *
 * It knows nothing about MCP tool names. Method + named params go over the pipe
 * verbatim; Plan 3's command map decides what they mean (spec Addendum A).
 *
 * @module security/sandbox/client
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildClient = buildClient;
const methods_1 = require("./methods");
/** A result that means the command failed. */
function isFailure(raw) {
    return !!raw && typeof raw === 'object' && raw.success === false;
}
/**
 * Build the `supersurf` client object.
 *
 * @param send - Pipe transport, supplied by the child
 * @param permissions - `meta.permissions`; a gated method is built only when its
 *                      permission appears here
 */
function buildClient(send, permissions = []) {
    const root = {};
    for (const [path, spec] of Object.entries(methods_1.METHODS)) {
        const required = methods_1.PERMISSION_GATED[path];
        if (required && !permissions.includes(required)) {
            continue; // NOT BUILT — this is the enforcement
        }
        const method = async (...args) => {
            const raw = await send(path, (0, methods_1.buildParams)(spec, args));
            if (isFailure(raw)) {
                throw new Error(raw.error || `${path} failed`);
            }
            if (spec.returnsBoolean) {
                return typeof raw === 'boolean' ? raw : raw?.visible === true;
            }
            return raw;
        };
        const segments = path.split('.');
        let target = root;
        for (let i = 0; i < segments.length - 1; i++) {
            if (!target[segments[i]])
                target[segments[i]] = {};
            target = target[segments[i]];
        }
        target[segments[segments.length - 1]] = method;
    }
    return root;
}
//# sourceMappingURL=client.js.map