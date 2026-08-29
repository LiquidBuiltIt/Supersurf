/**
 * The playbook run lifecycle.
 *
 * A run gets its OWN daemon session and its OWN tab, and the tab is CLOSED at
 * the end. `client_id` IS the daemon session id — `daemon/src/ipc.ts:144-151`
 * rejects a duplicate with `Session ID already in use` — so the run's id must
 * differ from the parent's. The parent is whichever process holds a
 * `ConnectionManager`: the MCP server or the CLI. Never the daemon.
 *
 * Because the tab dies at exit (spec §10 risk 2), a failed run captures a
 * snapshot BEFORE teardown and stores it as `evidence` on the run record.
 * Skip that and every failure reads as "it broke, no idea why".
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
  durationMs: number;
  logs: string[];
  evidence?: { snapshot?: string };
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

/** `rawResult` failures come back as data; the child expects a throw. */
function unwrap(res: any): unknown {
  if (res && res.success === false) {
    throw new Error(String(res.error ?? res.message ?? actionFailures(res) ?? 'command failed'));
  }
  return res;
}

/** Best-effort page capture for the failure record. Never throws. */
async function captureEvidence(backend: RunnerBackend): Promise<{ snapshot?: string } | undefined> {
  try {
    const res: any = await backend.callTool('browser_snapshot', {}, { rawResult: true });
    if (!res || res.success === false) return undefined;
    // `browser_snapshot` with `rawResult` spreads the extension payload at the
    // TOP LEVEL — the real keys are `nodes` and `formFields`. There is no
    // `snapshot` and no `result` wrapper, so reading those first (and stopping
    // at `null`) meant evidence was NEVER captured against the live tool.
    // The wrapper keys stay as a fallback for a transport that adds one.
    const snap = res.snapshot ?? res.result ?? res;
    if (!snap) return undefined;
    return { snapshot: typeof snap === 'string' ? snap : JSON.stringify(snap) };
  } catch {
    return undefined;
  }
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
    if (profile) rec.profile = profile;
    if (out.evidence) rec.evidence = out.evidence;
    appendRunRecord(record.name, rec);
    return { ...out, logs };
  };

  if (!record.valid || !record.meta) {
    return finish({
      ok: false,
      error: record.error ?? `\`${record.name}\` did not validate.`,
      durationMs: Date.now() - started,
    });
  }

  const paramError = validateParams(record.meta, params);
  if (paramError) {
    return finish({ ok: false, error: paramError, durationMs: Date.now() - started });
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
      durationMs: Date.now() - started,
    });
  }

  let tabOpened = false;
  let evidence: { snapshot?: string } | undefined;
  let outcome: PlaybookRunResult;

  try {
    // Own tab. `meta.startingPoint` is a discovery hint, not a URL to load —
    // the script's first `goto` decides where it actually lands.
    await backend.callTool('browser_tabs', { action: 'new' }, { rawResult: true });
    tabOpened = true;

    outcome = await runScript({
      file: record.file,
      params,
      meta: record.meta,
      onCommand: async (method: string, cmdParams: any) => {
        const { tool, args } = mapCommand(method, cmdParams, record.name);
        return unwrap(await backend.callTool(tool, args, { rawResult: true }));
      },
      onLog: (msg: string) => {
        logs.push(msg);
        opts.onLog?.(msg);
      },
    });
  } catch (err: any) {
    outcome = { ok: false, error: err?.message ?? String(err), durationMs: Date.now() - started };
  }

  // Evidence BEFORE teardown — the tab is about to stop existing.
  if (!outcome.ok && tabOpened) {
    evidence = await captureEvidence(backend);
  }

  if (tabOpened) {
    try { await backend.callTool('browser_tabs', { action: 'close' }, { rawResult: true }); } catch { /* teardown */ }
  }
  try { await backend.callTool('disconnect', {}, { rawResult: true }); } catch { /* teardown */ }

  return finish({
    ok: outcome.ok,
    result: outcome.result,
    error: outcome.error,
    durationMs: outcome.durationMs,
    evidence,
  });
}
