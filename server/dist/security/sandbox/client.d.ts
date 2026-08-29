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
/** Send one command over the pipe and resolve with the far end's result. */
export type SendCommand = (method: string, params: Record<string, unknown>) => Promise<unknown>;
/**
 * Build the `supersurf` client object.
 *
 * @param send - Pipe transport, supplied by the child
 * @param permissions - `meta.permissions`; a gated method is built only when its
 *                      permission appears here
 */
export declare function buildClient(send: SendCommand, permissions?: string[]): Record<string, any>;
//# sourceMappingURL=client.d.ts.map