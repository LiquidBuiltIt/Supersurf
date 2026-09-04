/**
 * The playbook run lifecycle.
 *
 * A run gets its OWN daemon session and its OWN tab, and the tab is CLOSED at
 * the end. `client_id` IS the daemon session id — `daemon/src/ipc.ts:144-151`
 * rejects a duplicate with `Session ID already in use` — so the run's id must
 * differ from the parent's. The parent is whichever process holds a
 * `ConnectionManager`: the MCP server or the CLI. Never the daemon.
 *
 * Because the tab dies at exit (spec §10 risk 2), a `SelectorMiss` failure
 * captures a ranked candidate-selector list BEFORE teardown and stores it as
 * `evidence` on the run record. The other five failure types have no page
 * left to read, so they carry no evidence at all.
 *
 * @module playbooks/runner
 */

import { ConnectionManager } from '../backend';
import { buildConfigService, backendConfigFrom } from '../backend-config';
import { mapCommand } from './command-map';
import { experimentRegistry } from '../experimental';
import { initSession as initHumanization } from '../experimental/mouse-humanization/index';
import { appendRunRecord, type RunRecord } from './runs';
import {
  runPlaybookScript,
  type PlaybookRunOptions,
  type PlaybookRunResult,
} from '../security/sandbox/host';
import type { PlaybookMeta } from '../security/meta';
import type { ValidationRecord } from '../security/validate';
import {
  classifyToolFailure,
  PlaybookCommandError,
  type PlaybookErrorType,
  type FailureAt,
} from './errors';
import { captureCandidates, type Candidate } from './candidates';

const { version: PACKAGE_VERSION } = require('../../package.json');

/** The sandbox-host entrypoint, seam-able for unit tests. */
type RunScript = (opts: PlaybookRunOptions) => Promise<PlaybookRunResult>;

/** The slice of `ConnectionManager` a run needs. Narrow so tests can fake it. */
export interface RunnerBackend {
  callTool(name: string, args: Record<string, unknown>, options?: { rawResult?: boolean }): Promise<any>;
}

export interface RunPlaybookOptions {
  record: ValidationRecord;
  params: Record<string, unknown>;
  caller: 'agent' | 'cli';
  /** Overrides `meta.profile`, which is only a default. */
  profile?: string;
  onLog?: (msg: string) => void;
  /** Test seams. */
  createBackend?: () => RunnerBackend;
  runScript?: RunScript;
  /** Test seam for Addendum B activation. Receives this run's `client_id`. */
  enableExperiments?: (clientId: string) => void;
}

export interface RunOutcome {
  ok: boolean;
  result?: unknown;
  error?: string;
  /** Which kind of failure. Absent on success. */
  type?: PlaybookErrorType;
  /** Which command threw, and its 1-based index in this run. */
  at?: FailureAt;
  /** The in-child stack. Names the playbook line that threw. */
  stack?: string;
  durationMs: number;
  logs: string[];
  /**
   * `SelectorMiss` ONLY. There is no `snapshot` key any more: the other five
   * types have no page worth reading, and the accessibility tree this replaces
   * hit 766 KB on a single `github.com` failure.
   */
  evidence?: { url?: string; title?: string; candidates?: Candidate[] };
}

function defaultBackend(): RunnerBackend {
  return new ConnectionManager(backendConfigFrom(buildConfigService({}), PACKAGE_VERSION));
}

/**
 * Addendum B activation. Enables every name in `AVAILABLE_EXPERIMENTS` for THIS
 * RUN'S SESSION ONLY.
 *
 * Two hard rules, both load-bearing:
 *   1. It MUST NOT write `~/.supersurf/config.json`. A playbook is not allowed
 *      to change the user's persistent configuration; the flag dies with the run.
 *   2. It MUST NOT touch the calling agent's session. Plan 1's session-scoped
 *      registry is what makes that true, which is why this fires only after the
 *      run's own `connect` has established its own session.
 *
 * Signatures are Plan 1's, not today's. `listAvailable(): string[]` is the
 * enumerator (there is no `list()`), and after Plan 1 the MUTATORS are
 * session-first — `enable(sessionId, feature)` — while the READERS keep
 * `feature` first with an optional trailing session id. Passing a feature name
 * into the sessionId slot compiles and silently does nothing.
 *
 * The `initHumanization` call is NOT optional. Plan 1's `onConnect` gates
 * `initHumanization(clientId)` behind `isEnabled('mouse_humanization', clientId)`
 * evaluated DURING connect, and we enable AFTER connect. Without this line the
 * humanization session is never created, `generateMovement` throws,
 * `moveCursorTo` swallows it, and every mouse move in the run degrades to a raw
 * CDP teleport — the exact bug Plan 1 exists to fix, reintroduced for playbook
 * runs only.
 */
export function defaultEnableExperiments(clientId: string): void {
  const names = experimentRegistry.listAvailable();
  for (const name of names) {
    experimentRegistry.enable(clientId, name);
  }
  if (names.includes('mouse_humanization')) {
    initHumanization(clientId);
  }
}

/**
 * Check the caller's arguments against `meta.params`. Returns an error string
 * or null. Unknown keys are an error, not a silent drop — a typo'd param name
 * that vanishes is the worst kind of bug to chase.
 */
export function validateParams(meta: PlaybookMeta, params: Record<string, unknown>): string | null {
  const spec = meta.params ?? {};
  const problems: string[] = [];

  for (const [key, def] of Object.entries(spec)) {
    const val = params[key];
    if (val === undefined) {
      if (def.required) problems.push(`missing required param \`${key}\` (${def.type})`);
      continue;
    }
    if (typeof val !== def.type) {
      problems.push(`param \`${key}\`: expected ${def.type}, got ${typeof val}`);
    }
  }

  for (const key of Object.keys(params)) {
    if (!(key in spec)) problems.push(`unknown param \`${key}\``);
  }

  return problems.length === 0 ? null : problems.join('; ');
}

/**
 * `browser_interact` is the batch tool `mapCommand` targets for all 15
 * interaction verbs, and its failure envelope is
 * `{ success: false, actions: ['✗ click: Element not found: `#foo`'] }` —
 * there is NO `error` and NO `message` key. Reading only those two keys
 * collapsed every failed click/type/hover in a playbook to the useless string
 * "command failed" and discarded the one line that says what actually broke.
 */
function actionFailures(res: any): string | null {
  if (!Array.isArray(res?.actions)) return null;
  const lines = res.actions.map(String).filter((l: string) => l.startsWith('✗'));
  const picked = lines.length > 0 ? lines : res.actions.map(String);
  return picked.length > 0 ? picked.join('; ') : null;
}

/**
 * `rawResult` failures come back as data; the child expects a throw. The throw
 * is typed here and nowhere else — this is the only place that sees the MCP
 * tool name, its arguments (hence the selector), and the failure envelope at
 * the same moment.
 */
function unwrapTyped(tool: string, args: Record<string, unknown>, res: any): unknown {
  if (res && res.success === false) {
    const message = String(res.error ?? res.message ?? actionFailures(res) ?? 'command failed');
    const { type, payload } = classifyToolFailure(tool, args, message);
    throw new PlaybookCommandError(message, type, payload);
  }
  return res;
}

export async function runPlaybook(opts: RunPlaybookOptions): Promise<RunOutcome> {
  const started = Date.now();
  const logs: string[] = [];
  const { record, params, caller } = opts;

  // `meta.profile` is a DEFAULT the caller may override.
  const profile = opts.profile ?? record.meta?.profile;

  // Addendum B. `meta.experiments === true` opts this run into every experiment.
  // Plan 2 parses and validates the field; activation is ours because the
  // ConnectionManager is ours.
  const wantsExperiments = record.meta?.experiments === true;

  const finish = (out: Omit<RunOutcome, 'logs'>): RunOutcome => {
    const rec: RunRecord = {
      ts: started,
      params,
      ok: out.ok,
      durationMs: out.durationMs,
      caller,
      experiments: wantsExperiments,
    };
    if (out.error) rec.error = out.error;
    if (out.type) rec.type = out.type;
    if (out.at) rec.at = out.at;
    if (out.stack) rec.stack = out.stack;
    if (profile) rec.profile = profile;
    if (out.evidence) rec.evidence = out.evidence;
    appendRunRecord(record.name, rec);
    return { ...out, logs };
  };

  if (!record.valid || !record.meta) {
    return finish({
      ok: false,
      error: record.error ?? `\`${record.name}\` did not validate.`,
      type: 'Refused',
      durationMs: Date.now() - started,
    });
  }

  const paramError = validateParams(record.meta, params);
  if (paramError) {
    return finish({ ok: false, error: paramError, type: 'Refused', durationMs: Date.now() - started });
  }

  const runScript: RunScript = opts.runScript ?? runPlaybookScript;
  const backend = (opts.createBackend ?? defaultBackend)();

  // Own session. The daemon rejects a duplicate id, so this must not collide
  // with the parent MCP session's client_id.
  const clientId = `playbook-${record.name}-${process.pid}-${Date.now()}`;
  const connectArgs: Record<string, unknown> = { client_id: clientId };
  if (profile) connectArgs.profile = profile;

  const connectRes: any = await backend.callTool('connect', connectArgs, { rawResult: true });

  // Activate AFTER connect: Plan 1 scopes the registry per session, so the
  // session this run just created is the one that gets flipped. Never before,
  // or the flags land on whatever session was current.
  if (connectRes?.success && wantsExperiments) {
    (opts.enableExperiments ?? defaultEnableExperiments)(clientId);
  }

  if (!connectRes?.success) {
    return finish({
      ok: false,
      error: `Connect failed: ${connectRes?.message ?? connectRes?.error ?? 'unknown error'}`,
      type: 'HarnessUnavailable',
      durationMs: Date.now() - started,
    });
  }

  let tabOpened = false;
  let evidence: { url?: string; title?: string; candidates?: Candidate[] } | undefined;
  let outcome: PlaybookRunResult;

  // Own tab. `meta.startingPoint` is a discovery hint, not a URL to load —
  // the script's first `goto` decides where it actually lands.
  //
  // `createTab` does not throw on failure — it returns `{ success: false,
  // error }` as ordinary data (the dispatcher's catch-all wraps a thrown
  // extension error into that shape). Discarding the return value here used
  // to mean a failed open silently fell through to `tabOpened = true`, and
  // the run then drove — and at teardown CLOSED — whatever tab the CALLING
  // agent had attached. Check the envelope before trusting it.
  // Teardown below is straight-line, not a `finally`, so a throw escaping this
  // call would leak the session it just opened. Fold a throw into the same
  // failure envelope the dispatcher produces.
  let newTabRes: any;
  try {
    newTabRes = await backend.callTool('browser_tabs', { action: 'new' }, { rawResult: true });
  } catch (err: any) {
    newTabRes = { success: false, error: err?.message ?? String(err) };
  }

  if (newTabRes?.success === false) {
    try { await backend.callTool('disconnect', {}, { rawResult: true }); } catch { /* teardown */ }
    return finish({
      ok: false,
      error: `Tab open failed: ${newTabRes?.message ?? newTabRes?.error ?? 'unknown error'}`,
      type: 'HarnessUnavailable',
      durationMs: Date.now() - started,
    });
  }
  tabOpened = true;

  // The run's step counter lives in `host.ts`, which owns the ONE `at` that
  // reaches the record: its `handleCommand` catch spreads `at` over
  // `playbookPayload`, so a second `at` built here was always overwritten.
  try {
    outcome = await runScript({
      file: record.file,
      params,
      meta: record.meta,
      hash: record.hash,
      onCommand: async (method: string, cmdParams: any) => {
        const { tool, args: toolArgs } = mapCommand(method, cmdParams, record.name);
        return unwrapTyped(tool, toolArgs, await backend.callTool(tool, toolArgs, { rawResult: true }));
      },
      onLog: (msg: string) => {
        logs.push(msg);
        opts.onLog?.(msg);
      },
    });
  } catch (err: any) {
    outcome = {
      ok: false,
      error: err?.message ?? String(err),
      type: err?.playbookType ?? 'HarnessUnavailable',
      payload: err?.playbookPayload,
      durationMs: Date.now() - started,
    };
  }

  // Evidence BEFORE teardown — the tab is about to stop existing.
  //
  // ONLY for `SelectorMiss`. The other five types have no page to read:
  // `Refused` and `ScriptAssertion` never reached the browser,
  // `HarnessUnavailable` means it is gone, `PageUnavailable` means the page
  // never loaded, and `Timeout` killed the child mid-flight. Capturing anyway
  // is what produced a 766 KB record whose useful content was one sentence.
  const failedSelector = outcome.type === 'SelectorMiss'
    ? (outcome.payload?.selector as string | undefined)
    : undefined;
  if (tabOpened && failedSelector) {
    evidence = await captureCandidates(backend, failedSelector);
  }

  if (tabOpened) {
    try { await backend.callTool('browser_tabs', { action: 'close' }, { rawResult: true }); } catch { /* teardown */ }
  }
  try { await backend.callTool('disconnect', {}, { rawResult: true }); } catch { /* teardown */ }

  return finish({
    ok: outcome.ok,
    result: outcome.result,
    error: outcome.error,
    type: outcome.type,
    at: outcome.payload?.at as FailureAt | undefined,
    stack: outcome.stack,
    durationMs: outcome.durationMs,
    evidence,
  });
}
