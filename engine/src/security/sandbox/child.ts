/**
 * The playbook sandbox child process — Layer 3, the only kernel-enforced boundary.
 *
 * Layers 1 (static analysis) and 2 (the vm context) are filters; `node:vm` is
 * explicitly NOT a security boundary per Node's own docs. This process is.
 * It is spawned with no environment, a throwaway cwd, and pipe-only stdio.
 *
 * The child NEVER reads from disk. Source arrives in the `init` frame so the
 * server remains the single control point and authorizes before sending
 * anything. There is no `fs` import in this file, and there must never be one.
 *
 * stdout is the protocol pipe: nothing but NDJSON frames may be written to it.
 * Diagnostics go to stderr, which the host forwards to `onLog`.
 *
 * @module security/sandbox/child
 */

import { createPlaybookContext, compilePlaybook, DEFAULT_EXPORT_KEY } from './context';
import { buildClient } from './client';

// ── Lockdown ────────────────────────────────────────────────
// The host already spawns us with `env: {}`, but a stray inherited variable
// would be a credential leak, so clear whatever is here before user code runs.
for (const key of Object.keys(process.env)) delete process.env[key];

/** Write one NDJSON frame to the pipe. */
function emit(frame: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(frame) + '\n');
}

/** Write a final frame, flush, and exit. */
function emitAndExit(frame: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(frame) + '\n', () => process.exit(0));
}

// ── Command plumbing ────────────────────────────────────────

let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

/** Send one command and wait for its `res` frame. */
function send(method: string, params: Record<string, unknown>): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    emit({ t: 'cmd', id, method, params });
  });
}

/** Handle a `res` frame from the host. */
function settle(frame: any): void {
  const entry = pending.get(frame.id);
  if (!entry) return;
  pending.delete(frame.id);
  if (frame.ok) { entry.resolve(frame.result); return; }
  // INERT, and deliberately kept. The tag below NEVER SURVIVES: this rejection
  // travels out through a host method, and `wrap()` in `context.ts` rebuilds
  // every such throw as a bare vm-realm `new Error(String(e.message))`. The
  // script — and therefore the catch below, and therefore the `fail` frame —
  // sees a fresh error with no `__ssType` on it at all.
  //
  // So this does NOT tell an unwrap throw from the script's own throw, and the
  // `errorType`/`errorPayload` keys the host writes onto a `res` frame
  // (`host.ts`) are inert for the same reason. What actually types an uncaught
  // tool failure is HOST-SIDE CORRELATION: `host.ts` remembers the failure it
  // classified itself and matches it against the `fail` frame's message.
  //
  // Read that before touching the host's `frame.type` gate. `frame.type` is
  // untrusted child input, and the gate is not redundant with anything here.
  // Non-enumerable so a script cannot read the tag off an error it catches.
  const err = new Error(String(frame.error ?? 'command failed'));
  Object.defineProperty(err, '__ssType', { value: frame.errorType, enumerable: false });
  Object.defineProperty(err, '__ssPayload', { value: frame.errorPayload, enumerable: false });
  entry.reject(err);
}

// ── Run ─────────────────────────────────────────────────────

let started = false;

async function start(init: any): Promise<void> {
  if (started) return;
  started = true;

  const meta = init.meta ?? {};
  const params = init.params ?? {};
  const log = (message: unknown) => emit({ t: 'log', message: String(message) });
  const supersurf = buildClient(send, Array.isArray(meta.permissions) ? meta.permissions : []);

  try {
    // `params` and `log` are vm globals (spec §7.7); the default export is ALSO
    // called with { supersurf, params, log } because the canonical example in
    // spec §7.10 destructures its single argument.
    const context = createPlaybookContext({ supersurf, params, log });
    compilePlaybook(String(init.source ?? ''), String(init.file ?? 'playbook.js')).runInContext(context);

    const entry = (context as any)[DEFAULT_EXPORT_KEY];
    if (typeof entry !== 'function') {
      throw new Error('playbook has no default export function — expected `export default async function ({ supersurf, params }) { … }`');
    }

    // Read the RE-REALMED values back off the context (`vm.createContext`
    // keeps the sandbox object in sync with the vm global). Passing the host
    // locals here would hand the playbook `supersurf.click.constructor` — a
    // HOST `Function` that compiles in the host realm — and re-realming the
    // globals would be cosmetic, because the canonical playbook destructures
    // exactly this argument rather than reading the globals.
    const ctx = context as any;
    const result = await entry({ supersurf: ctx.supersurf, params: ctx.params, log: ctx.log });
    emitAndExit({ t: 'done', result: result === undefined ? null : result });
  } catch (e: any) {
    emitAndExit({
      t: 'fail',
      message: String(e?.message ?? e),
      stack: String(e?.stack ?? ''),
      // Untagged means the script threw on its own. The host defaults an absent
      // type to `ScriptAssertion`; sending it explicitly keeps the frame honest.
      type: e?.__ssType ?? 'ScriptAssertion',
      payload: e?.__ssPayload,
    });
  }
}

// ── stdin frame reader ──────────────────────────────────────

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let index: number;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let frame: any;
    try {
      frame = JSON.parse(line);
    } catch {
      continue; // a malformed line is the host's bug; never crash the run over it
    }
    if (frame.t === 'init') void start(frame);
    else if (frame.t === 'res') settle(frame);
  }
});

// A closed pipe means the host is gone. Nothing left to report to.
process.stdin.on('end', () => process.exit(0));

process.on('uncaughtException', (e: any) => {
  emitAndExit({
    t: 'fail', message: String(e?.message ?? e), stack: String(e?.stack ?? ''),
    type: e?.__ssType ?? 'ScriptAssertion', payload: e?.__ssPayload,
  });
});
process.on('unhandledRejection', (e: any) => {
  emitAndExit({
    t: 'fail', message: String(e?.message ?? e), stack: String(e?.stack ?? ''),
    type: e?.__ssType ?? 'ScriptAssertion', payload: e?.__ssPayload,
  });
});
