/**
 * The playbook failure taxonomy.
 *
 * Before this module there were NO error types: `child.ts`'s single catch block
 * turned a script's own `throw`, a failed tool call, and a plain `TypeError`
 * into the same `{ t: 'fail', message }` frame, and `RunRecord` stored a bare
 * `error?: string`. The consequence was an evidence policy that could not
 * discriminate — every failure captured an uncapped page snapshot, including
 * the four kinds of failure that have no page to snapshot.
 *
 * The type is what sizes the payload. Four of the six never touch a page:
 * `Refused` and `ScriptAssertion` never reach the browser, `HarnessUnavailable`
 * means the browser is gone, and `PageUnavailable` means the page never loaded.
 * Only `SelectorMiss` justifies reading the DOM after the fact.
 *
 * This module is PURE and imports nothing from the rest of the codebase, so
 * `security/sandbox/host.ts` can `import type` from it without a cycle.
 *
 * @module playbooks/errors
 */

/** The six ways a playbook run can end badly. */
export type PlaybookErrorType =
  /** A selector matched nothing: click/type/wait targets, zero-match extract. */
  | 'SelectorMiss'
  /** The sandbox wall clock expired and the child was killed. */
  | 'Timeout'
  /** No usable page: a network-error interstitial, or a crashed renderer. */
  | 'PageUnavailable'
  /** The extension, daemon, tab, or sandbox child went away. */
  | 'HarnessUnavailable'
  /**
   * The harness declined: hash mismatch, bad params, secure_eval.
   *
   * `withheld-method`/`unknown-method` are also modeled as `Refused` reasons in
   * `playbooks/command-map.ts`, but that route is NOT reachable in production
   * today: `buildClient` (`security/sandbox/client.ts`) only builds a method
   * onto the vm's `supersurf` object when it is both declared in `METHODS`
   * (`security/sandbox/methods.ts`) and permission-granted, so a withheld or
   * unknown method is simply absent from the object — calling it throws a bare
   * `supersurf.X is not a function` TypeError INSIDE the vm, which the child
   * reports as an untagged `fail` frame and this module's `runPlaybookScript`
   * types as `ScriptAssertion`. `mapCommand`'s `WITHHELD`/unknown-method checks
   * never run, because `onCommand` is never invoked for a call that never
   * leaves the vm. Verified: `METHODS` and `MAP` carry identical 52-key sets,
   * and `WITHHELD ∩ MAP` is empty. Making the withheld-method reason reachable
   * would need a `Proxy` in the vm client — out of scope here.
   */
  | 'Refused'
  /** The script threw on its own — a param guard, an assertion, a TypeError. */
  | 'ScriptAssertion';

/** Which command threw, and where in the run. */
export interface FailureAt {
  /** 1-based index over the commands this run issued. */
  step: number;
  /** The `supersurf.*` client method name, e.g. `click`, `extract`. */
  method: string;
}

/**
 * A tool failure that already knows what kind of failure it is.
 *
 * Thrown by the runner's `onCommand`, caught by `host.ts`'s `handleCommand`,
 * whose catch copies `playbookType`/`playbookPayload` onto the `res` frame. The
 * child re-throws a tagged Error so its own catch can tell an unwrap throw from
 * a script throw — the ONE distinction `child.ts` could not previously make.
 */
export class PlaybookCommandError extends Error {
  readonly playbookType: PlaybookErrorType;
  readonly playbookPayload: Record<string, unknown>;

  constructor(message: string, type: PlaybookErrorType, payload: Record<string, unknown> = {}) {
    super(message);
    this.name = 'PlaybookCommandError';
    this.playbookType = type;
    this.playbookPayload = payload;
  }
}

/**
 * Dig the selector out of a tool's arguments.
 *
 * Three shapes, because `mapCommand` produces three: a plain `selector` key,
 * `browser_interact`'s `{ actions: [{ selector }] }` batch, and
 * `browser_fill_form`'s `{ fields: [{ selector }] }` batch.
 */
export function selectorOf(args: Record<string, unknown>): string | undefined {
  const direct = args?.selector;
  if (typeof direct === 'string' && direct) return direct;

  const actions = args?.actions;
  if (Array.isArray(actions)) {
    for (const a of actions) {
      const s = (a as any)?.selector;
      if (typeof s === 'string' && s) return s;
    }
  }

  const fields = args?.fields;
  if (Array.isArray(fields)) {
    for (const f of fields) {
      const s = (f as any)?.selector;
      if (typeof s === 'string' && s) return s;
    }
  }

  const from = args?.fromSelector;
  if (typeof from === 'string' && from) return from;

  return undefined;
}

/**
 * Match order matters: the SPECIFIC patterns run before the general ones.
 * `Timeout waiting for element:` contains the word "timeout" but is a selector
 * problem, not the sandbox wall clock, so it must be tested before anything
 * that looks for a timeout.
 *
 * Every pattern below is a verbatim substring of a message this codebase
 * actually produces — `interaction/type.ts`, `interaction/wait.ts`,
 * `tools/content.ts`, `tools/navigation.ts`, `tools.ts`,
 * `tools/lib/dispatcher.ts`, `tools/browser_evaluate/index.ts`.
 *
 * NOT `playbooks/command-map.ts`. Its two refusals are thrown as
 * `PlaybookCommandError`s that already carry `Refused`, and the runner calls
 * `mapCommand` before `unwrapTyped`, so they never reach this function at all.
 * The withheld-method patterns below stay only as a safety net for the same
 * wording arriving from somewhere else.
 */
export function classifyToolFailure(
  tool: string,
  args: Record<string, unknown>,
  message: string,
): { type: PlaybookErrorType; payload: Record<string, unknown> } {
  const m = message || '';

  if (
    m.includes('Element not found')
    || m.includes('Timeout waiting for element')
    || m.includes('Failed to focus')
    || m.includes('No content element found')
  ) {
    const selector = selectorOf(args);
    return { type: 'SelectorMiss', payload: selector ? { selector } : {} };
  }

  // `tools/lib/dispatcher.ts` rewrites two CDP failures into its own recovery
  // prose before the runner sees them, so neither "Target crashed" nor "CDP
  // timeout: Runtime.evaluate" is ever on the wire — match the rewritten text.
  // Both landed in the `Refused` catch-all below, which tells an agent the
  // harness declined and it should not retry; the truth is the tab is dead and
  // has to be reopened. Neither warrants a seventh type: a crashed renderer is
  // a page that cannot be used, and a hung evaluate is a clock that ran out.
  if (m.includes('renderer process crashed')) {
    return { type: 'PageUnavailable', payload: { reason: 'renderer-crash' } };
  }

  if (m.includes('JavaScript evaluation in the page timed out')) {
    return { type: 'Timeout', payload: { reason: 'cdp-evaluate-timeout' } };
  }

  if (m.includes('Chrome displayed an error interstitial')) {
    const url = args?.url;
    return {
      type: 'PageUnavailable',
      payload: typeof url === 'string' ? { requestedUrl: url } : {},
    };
  }

  if (m.includes('Extension not connected')) {
    return {
      type: 'HarnessUnavailable',
      payload: { component: 'extension', hint: 'Open the extension popup and verify it shows "Connected".' },
    };
  }

  if (m.includes('secure_eval')) {
    return { type: 'Refused', payload: { reason: 'secure_eval', detail: firstLine(m) } };
  }

  if (m.includes('is not available to playbook scripts') || m.includes('Unknown playbook command')) {
    return { type: 'Refused', payload: { reason: 'withheld-method', detail: firstLine(m) } };
  }

  // An unrecognised tool failure is still the harness declining the command.
  // `Refused` is the honest default because it is the one type that claims
  // nothing about the page and therefore captures no evidence — guessing
  // `SelectorMiss` here would trigger a page read for a failure that may have
  // nothing to do with a selector.
  return { type: 'Refused', payload: { reason: 'tool-error', detail: tool } };
}

function firstLine(s: string): string {
  const line = s.split('\n')[0].trim();
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}
