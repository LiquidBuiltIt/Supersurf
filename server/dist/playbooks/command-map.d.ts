/**
 * `supersurf` client method -> MCP tool call.
 *
 * Spec §7.6 puts the CLIENT method name on the wire (`{"t":"cmd","method":"click",…}`),
 * and §7.5's `runPlaybookScript` hands it to `onCommand` unchanged. `host.ts` holds
 * no `ConnectionManager`, so the translation to an MCP tool belongs on this side of
 * the pipe — here.
 *
 * The `params` shapes below are the §7.7 signatures with positional arguments
 * named after their parameters (`click(selector)` -> `{selector}`). Three of those
 * signatures do not line up one-for-one with the tool schema, and §7.7 is explicit
 * that plan authors read `server/src/tools/schemas.ts` for the exact params:
 *
 *   - `wait(msOrSelector)` is a union, so Addendum A pins its pipe key as
 *     `msOrSelector` and this map branches on the VALUE TYPE — a number is a delay,
 *     a string is a wait-for-element. Getting that branch wrong silently turns
 *     `wait('#done')` into a zero-length sleep.
 *   - `fill(fields: Record<string, string>)` is a map, but `browser_fill_form` takes
 *     an ARRAY of `{selector, value}`. Bridging the two is this module's job.
 *   - `drag(from, to)` and `secureFill(selector, envName)` land on schema parameters
 *     named `fromSelector`/`toSelector` and `credential_env`.
 *
 * `evaluate` is the last exception. The real `browser_evaluate` schema takes
 * `function`/`expression` (never `code`), and its handler HARD-REJECTS an empty
 * `purpose`. The client signature stays `evaluate(code)` per §7.7 — this map
 * supplies `purpose: 'playbook:<name>'` itself. Non-empty by construction, and it
 * makes the usage-metrics trail readable. Do NOT add a `purpose` parameter to the
 * client method.
 *
 * Namespaced passthroughs (`tabs.*`, `storage.*`, …) and the `opts?` tail of
 * `extract`/`styles`/`screenshot`/`mouseClick` arrive as a single `opts` object,
 * because that is the parameter's name in §7.7. `mapCommand` flattens it before
 * dispatch, so every mapper below sees plain named keys.
 *
 * Permission enforcement is NOT here. Spec §5 enforces by construction — an
 * ungranted method is never built onto the client object, so it can never reach
 * the pipe. This map only translates.
 *
 * @module playbooks/command-map
 */
export interface MappedCommand {
    tool: string;
    args: Record<string, unknown>;
}
export declare const KNOWN_METHODS: string[];
export declare function mapCommand(method: string, params: any, playbookName?: string): MappedCommand;
//# sourceMappingURL=command-map.d.ts.map