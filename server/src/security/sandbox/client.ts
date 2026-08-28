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

import { METHODS, PERMISSION_GATED, buildParams } from './methods';

/** Send one command over the pipe and resolve with the far end's result. */
export type SendCommand = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/** A result that means the command failed. */
function isFailure(raw: any): raw is { success: false; error?: string } {
  return !!raw && typeof raw === 'object' && raw.success === false;
}

/**
 * Build the `supersurf` client object.
 *
 * @param send - Pipe transport, supplied by the child
 * @param permissions - `meta.permissions`; a gated method is built only when its
 *                      permission appears here
 */
export function buildClient(send: SendCommand, permissions: string[] = []): Record<string, any> {
  const root: Record<string, any> = {};

  for (const [path, spec] of Object.entries(METHODS)) {
    const required = PERMISSION_GATED[path];
    if (required && !permissions.includes(required)) {
      continue; // NOT BUILT — this is the enforcement
    }

    const method = async (...args: unknown[]): Promise<unknown> => {
      const raw = await send(path, buildParams(spec, args));
      if (isFailure(raw)) {
        throw new Error(raw.error || `${path} failed`);
      }
      if (spec.returnsBoolean) {
        return typeof raw === 'boolean' ? raw : (raw as any)?.visible === true;
      }
      return raw;
    };

    const segments = path.split('.');
    let target = root;
    for (let i = 0; i < segments.length - 1; i++) {
      if (!target[segments[i]]) target[segments[i]] = {};
      target = target[segments[i]];
    }
    target[segments[segments.length - 1]] = method;
  }

  return root;
}
