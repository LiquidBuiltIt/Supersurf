/**
 * The parent side of the playbook sandbox.
 *
 * Reads the file (the child never touches disk), validates the caller's params
 * against `meta.params`, spawns the locked-down child, and pumps the NDJSON
 * pipe until the script finishes, fails, or runs out of time.
 *
 * `onCommand` is forwarded VERBATIM (spec Addendum A): this module holds no
 * ConnectionManager and does no client-method → MCP-tool translation. That map
 * is a Plan 3 deliverable.
 *
 * Lockdown is `spawn`, not `fork`: `fork` opens an IPC channel and gives the
 * child `process.send`, a live handle back into the parent. The child gets
 * pipe-only stdio, `env: {}`, and a throwaway cwd.
 *
 * HONEST SCOPE: Node's permission model has no network flag. "No network" in
 * the child is enforced by omission inside the vm (no fetch, no http, no
 * require) — NOT by the kernel. The kernel-enforced part is process isolation
 * plus, on Node 20+, the filesystem permission flags below.
 *
 * @module security/sandbox/host
 */

import fsSync from 'fs';
import fs from 'fs/promises';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import type { PlaybookMeta } from '../meta';
import type { PlaybookErrorType, FailureAt } from '../../playbooks/errors';

/** Everything a run needs. */
export interface PlaybookRunOptions {
  file: string;
  params: Record<string, unknown>;
  meta: PlaybookMeta;
  /**
   * The sha256 the registry validated `file` against (`ValidationRecord.hash`).
   * `refreshRegistry()` gates its read on `mtime`+`size`, NOT content — two
   * writes that land on the same size at the same explicit mtime (e.g. a
   * fixed-width payload swap) skip the read entirely, and the cached record
   * keeps saying `valid: true` for bytes nobody has looked at. The registry
   * is the LISTING path; this is the EXECUTION path, and it must not inherit
   * that shortcut. The host re-hashes the bytes it is about to run and
   * refuses unless they equal this value — see the check in
   * `runPlaybookScript`. A timestamp is never the sole basis for a security
   * decision.
   */
  hash: string;
  /** Invoked for every command the script sends. The host validates and
   *  forwards to the browser. Rejects → the script's call throws. */
  onCommand: (method: string, params: any) => Promise<any>;
  onLog: (message: string) => void;
  timeoutMs?: number;    // default 300000
}

/** The outcome of one run. */
export interface PlaybookRunResult {
  ok: boolean;
  result?: unknown;      // the script's return value, present iff ok
  error?: string;        // present iff !ok
  /**
   * Which KIND of failure. Absent only on success. The runner writes this onto
   * the run record, and it is what decides whether the failure is worth reading
   * the page for — see `playbooks/errors.ts`.
   */
  type?: PlaybookErrorType;
  /** Type-specific detail: `{ selector }`, `{ requestedUrl }`, `{ reason }`. */
  payload?: Record<string, unknown>;
  stack?: string;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 300000;

/**
 * Caps on the two free-text fields of a `fail` frame.
 *
 * EVERY field of that frame is child-controlled and untrusted. `wrap()` in
 * `context.ts` rebuilds a thrown error as a bare vm-realm `Error` carrying only
 * `String(e.message)`, so nothing about a frame's shape is verifiable from this
 * side — a script can set `e.stack = 'Z'.repeat(2e6)` and the host has no way to
 * tell that from a real V8 stack.
 *
 * The cap belongs HERE, at the pipe, and not at the three places the value ends
 * up (`runner.ts` → `runs.ts`, which persists it forever in the sidecar, and
 * `tools/playbooks.ts`, which pushes it straight into an agent-facing MCP
 * response). One boundary owns "nothing unbounded crosses this pipe"; capping
 * downstream instead is how the NEXT field leaks. This is the same 766 KB bug
 * the error taxonomy exists to close, reached through a different field.
 *
 * A stack gets a few KB because the frames below the throw site are the useful
 * part. A message gets far less — it is one line in a rendered failure report.
 */
export const MAX_FAIL_STACK_CHARS = 4000;
export const MAX_FAIL_MESSAGE_CHARS = 1000;

/** Cut `s` to `limit`, leaving a visible marker that something was dropped. */
function capText(s: string, limit: number): string {
  return s.length > limit ? `${s.slice(0, limit)}…[truncated]` : s;
}

/**
 * Check the caller's arguments against `meta.params`.
 * @returns null when valid, otherwise a human-facing reason.
 */
export function validateParams(params: Record<string, unknown>, meta: PlaybookMeta): string | null {
  const declared = meta.params ?? {};
  for (const key of Object.keys(params)) {
    if (!(key in declared)) {
      const known = Object.keys(declared);
      return `unknown parameter "${key}"${known.length ? ` (declared: ${known.join(', ')})` : ' (this playbook declares no parameters)'}`;
    }
  }
  for (const [name, spec] of Object.entries(declared)) {
    const value = params[name];
    if (value === undefined) {
      if (spec.required) return `missing required parameter "${name}" (${spec.type})`;
      continue;
    }
    if (typeof value !== spec.type) {
      return `parameter "${name}" must be a ${spec.type} (got ${typeof value})`;
    }
  }
  return null;
}

/** Walk up from a file to the nearest directory containing package.json. */
function packageRootOf(entry: string): string {
  let dir = path.dirname(entry);
  for (let i = 0; i < 10; i++) {
    if (fsSync.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.dirname(entry);
}

/**
 * Node permission-model flags for the child.
 *
 * Read access is scoped to the code the child must load: the package that owns
 * the entry plus the hoisted `node_modules` above it (see `readRootsFor`).
 * **Write is never granted at all.** There is no network flag in Node's
 * permission model — do not pretend otherwise.
 *
 * The unbuilt-checkout fallback runs the TypeScript entry through tsx, which
 * needs loader and filesystem access the permission model denies, so it gets no
 * flags. That relaxation never reaches users: a published install, and any
 * built checkout, runs the compiled `child.js` with the flags on.
 */
export function permissionFlagsFor(nodeVersion: string, entry: string): string[] {
  if (entry.endsWith('.ts')) return [];
  const major = parseInt(nodeVersion.replace(/^v/, '').split('.')[0], 10);
  if (isNaN(major) || major < 20) return [];
  const flag = major >= 23 ? '--permission' : '--experimental-permission';
  return [flag, ...readRootsFor(entry).map((root) => `--allow-fs-read=${root}`)];
}

/**
 * Every directory the child must READ to load its own code.
 *
 * The package that owns the entry, plus each `node_modules` above it. Both npm
 * and pnpm HOIST dependencies out of the package directory — the child
 * imports `acorn`, which lands in the installer's top-level `node_modules`, not
 * in `supersurf-mcp/node_modules` — so a read scope of the package root
 * alone starves the child of its own imports and it dies before the first
 * frame. Read only, and only over code directories; write is still never
 * granted anywhere.
 */
function readRootsFor(entry: string): string[] {
  const root = packageRootOf(entry);
  const roots = [root];
  let dir = path.dirname(root);
  for (let i = 0; i < 10; i++) {
    const modules = path.join(dir, 'node_modules');
    if (fsSync.existsSync(modules) && !roots.includes(modules)) roots.push(modules);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return roots;
}

/**
 * Every place a compiled `child.js` may sit, most-preferred first.
 *
 * First: next to this module — a published install, where this file is
 * `dist/security/sandbox/host.js`. Second: the mirrored path under `dist/` for
 * a source checkout that runs the TypeScript out of `src/` (vitest, `npm run
 * dev.server`). The second candidate is what lets a built checkout skip tsx.
 */
function compiledChildCandidates(): string[] {
  const here = path.join(__dirname, 'child.js');
  const candidates = [here];
  const root = packageRootOf(here);
  const fromSrc = path.relative(path.join(root, 'src'), __dirname);
  if (!fromSrc.startsWith('..') && !path.isAbsolute(fromSrc)) {
    candidates.push(path.join(root, 'dist', fromSrc, 'child.js'));
  }
  return candidates;
}

/**
 * Find `tsx`'s CLI for the source-checkout fallback where only `child.ts` exists.
 *
 * `tsx` is a devDependency of this package: it resolves from a checkout and is
 * deliberately absent from a published install, which runs the compiled child.
 */
function resolveTsxCli(from: string): string {
  const looked: string[] = [];
  try {
    return require.resolve('tsx/cli');
  } catch {
    looked.push("require.resolve('tsx/cli')");
  }
  let dir = path.dirname(from);
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    looked.push(candidate);
    if (fsSync.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `tsx not found — cannot run the TypeScript sandbox child ${from}. Build the package `
    + '(`npm run build.server`) so the compiled child.js is used instead, or run `npm install` '
    + `to restore the tsx devDependency. Looked at: ${looked.join(', ')}`,
  );
}

/**
 * Refuse the run when the resolved child entry is the tsx/`child.ts` fallback,
 * unless the caller has explicitly opted out of sandboxing.
 *
 * `permissionFlagsFor` already returns `[]` for a `.ts` entry — tsx's loader
 * needs filesystem and module-resolution access the Node permission model
 * would deny — so an unbuilt source checkout spawns the untrusted playbook
 * with the process cage OFF: no `--allow-fs-read` scoping, unrestricted
 * filesystem read. A published install and any BUILT checkout never reach
 * this path; only a checkout that skipped `npm run build` does, but nothing
 * stops that checkout from also being a CI runner or a shared host, so the
 * relaxation must be a loud, explicit choice, not a silent fallback.
 *
 * `SUPERSURF_ALLOW_UNSANDBOXED_PLAYBOOK=1` is that explicit choice. Set it and
 * the run proceeds, but `onLog` gets a warning naming exactly what protection
 * is off — a silent downgrade of a security guarantee is worse than a loud one.
 *
 * @returns an error string to abort the run with, or `null` to proceed.
 */
export function checkChildEntrySandboxing(entry: string, onLog: (message: string) => void): string | null {
  if (!entry.endsWith('.ts')) return null; // compiled child.js — permission flags apply, nothing to check

  if (process.env.SUPERSURF_ALLOW_UNSANDBOXED_PLAYBOOK === '1') {
    onLog(
      '⚠️  SECURITY: running the playbook sandbox child via tsx with NO Node permission model. '
      + 'The compiled child.js was not found (unbuilt checkout), so this run has UNRESTRICTED '
      + 'filesystem read — no --allow-fs-read scoping is possible through the tsx loader. '
      + 'SUPERSURF_ALLOW_UNSANDBOXED_PLAYBOOK=1 is set, so the run proceeds anyway.',
    );
    return null;
  }

  return (
    'refusing to run: the playbook sandbox child would load via tsx with NO filesystem '
    + 'sandboxing — the Node permission model cannot be applied through the tsx loader, so the '
    + 'playbook would get unrestricted filesystem read. Run `npm run build` (or `npm run build.server`) '
    + 'so the compiled child.js is used instead. To run unsandboxed anyway — NOT recommended outside '
    + 'a local dev checkout — set SUPERSURF_ALLOW_UNSANDBOXED_PLAYBOOK=1.'
  );
}

/**
 * Locate the child entry.
 *
 * The COMPILED child wins wherever it exists — published install or built
 * source checkout — and runs under plain `node`. That keeps a TypeScript loader
 * out of the process that executes untrusted playbook code, and it keeps a
 * clean install working, because tsx never ships to users.
 *
 * tsx + `child.ts` is the fallback for an UNBUILT source checkout only.
 */
export function resolveChildEntry(): { command: string; argv: string[]; entry: string } {
  const looked: string[] = [];

  for (const js of compiledChildCandidates()) {
    looked.push(js);
    if (fsSync.existsSync(js)) return { command: process.execPath, argv: [js], entry: js };
  }

  const ts = path.join(__dirname, 'child.ts');
  looked.push(ts);
  if (fsSync.existsSync(ts)) return { command: process.execPath, argv: [resolveTsxCli(ts), ts], entry: ts };

  throw new Error(`playbook sandbox child entry not found — looked for: ${looked.join(', ')}`);
}

/** Run one playbook file to completion. Never throws — every outcome is a result. */
export function runPlaybookScript(opts: PlaybookRunOptions): Promise<PlaybookRunResult> {
  const started = Date.now();
  const done = (partial: Omit<PlaybookRunResult, 'durationMs'>): PlaybookRunResult =>
    ({ ...partial, durationMs: Date.now() - started });

  return (async (): Promise<PlaybookRunResult> => {
    const paramError = validateParams(opts.params, opts.meta);
    if (paramError) return done({ ok: false, error: paramError, type: 'Refused', payload: { reason: 'params' } });

    let source: string;
    try {
      source = await fs.readFile(opts.file, 'utf8');
    } catch (e: any) {
      return done({
        ok: false,
        error: `could not read ${opts.file}: ${e?.message ?? String(e)}`,
        type: 'Refused', payload: { reason: 'unreadable' },
      });
    }

    // The bytes that were statically analyzed and the bytes about to execute
    // must be provably the same. `opts.hash` is `ValidationRecord.hash` — see
    // the field doc on `PlaybookRunOptions` for why the registry's mtime/size
    // gate cannot be trusted for this comparison.
    const actualHash = crypto.createHash('sha256').update(source, 'utf8').digest('hex');
    if (actualHash !== opts.hash) {
      return done({
        ok: false,
        error: `${opts.file} changed since it was last validated (hash mismatch) — refusing to run `
          + 'unvalidated bytes. An ordinary edit moves the file\'s mtime, so the next tool call re-validates '
          + 'it and this clears; if it does not clear, the content changed without the mtime changing and the '
          + 'cached record is stale.',
        type: 'Refused', payload: { reason: 'hash-mismatch' },
      });
    }

    let entry: { command: string; argv: string[]; entry: string };
    try {
      entry = resolveChildEntry();
    } catch (e: any) {
      return done({
        ok: false,
        error: String(e?.message ?? e),
        type: 'HarnessUnavailable', payload: { component: 'sandbox-child' },
      });
    }

    const sandboxError = checkChildEntrySandboxing(entry.entry, opts.onLog);
    if (sandboxError) return done({ ok: false, error: sandboxError, type: 'Refused', payload: { reason: 'unsandboxed-child' } });

    const flags = permissionFlagsFor(process.version, entry.entry);
    const child = spawn(entry.command, [...flags, ...entry.argv], {
      // No environment: the child must never see credentials or config.
      env: {},
      // A cwd it has no reason to touch.
      cwd: os.tmpdir(),
      // Pipes only. No 'ipc' — that is why this is spawn and not fork.
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return await new Promise<PlaybookRunResult>((resolve) => {
      let settled = false;
      let stderr = '';
      let buffer = '';
      let commandStep = 0;
      /**
       * The most recent CLASSIFIED command failure. `context.ts`'s vm-realm
       * error rebuild (`wrap()`) is an isolation-posture boundary this module
       * must not touch — it intentionally strips every property off a
       * rethrown error except `.message`, so a tool failure the script does
       * not catch reaches the `fail` frame as an untyped `ScriptAssertion`
       * with only a message. This host-side memory is how the type survives
       * anyway: correlate on that message, not on the error object identity
       * the vm boundary already destroyed. Overwritten on every classified
       * failure — the LAST one wins, matching how the fail frame can only
       * ever report the failure that actually killed the run.
       *
       * This record — never anything read off a `fail` frame — is the ONLY
       * source of a result's `type`/`payload`. See the `fail` handler below:
       * `frame.type`/`frame.payload` are untrusted child input and must never
       * be adopted directly.
       *
       * `handleCommand` below is dispatched with `void`, so with concurrent
       * commands (e.g. a script awaiting `Promise.all([click(a), click(b)])`)
       * this is completion-ordered, not necessarily the command that actually
       * killed the run. That is safe: a mismatched message simply fails the
       * correlation check in the `fail` handler and the result degrades to
       * the untyped `ScriptAssertion` default rather than mislabeling a
       * failure with the wrong type.
       */
      let lastCommandFailure: { type: PlaybookErrorType; payload: Record<string, unknown>; message: string } | undefined;

      const finish = (result: PlaybookRunResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        resolve(result);
      };

      const limitMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const timer = setTimeout(() => {
        finish(done({
          ok: false,
          error: `playbook timed out after ${limitMs}ms`,
          type: 'Timeout',
          payload: { limitMs, elapsedMs: Date.now() - started },
        }));
      }, limitMs);

      /** Answer one `cmd` frame. */
      const handleCommand = async (frame: any) => {
        const step = ++commandStep;
        try {
          const result = await opts.onCommand(frame.method, frame.params);
          if (!settled) child.stdin.write(JSON.stringify({ t: 'res', id: frame.id, ok: true, result }) + '\n');
        } catch (e: any) {
          // `e` is a `PlaybookCommandError` when the runner classified it.
          //
          // `errorType`/`errorPayload` below are INERT and deliberately kept:
          // `child.ts` hangs them on the error it rejects with, but that
          // rejection leaves a host method through `wrap()` in `context.ts`,
          // which rebuilds it as a bare vm-realm Error carrying only the
          // message. Nothing the child tags ever reaches the `fail` frame.
          //
          // `lastCommandFailure` is what actually carries the type across: the
          // host's OWN record of a failure it classified itself, correlated
          // against the `fail` frame by message. See the `fail` handler.
          const message = String(e?.message ?? e);
          if (e?.playbookType) {
            const at: FailureAt = { step, method: frame.method };
            lastCommandFailure = { type: e.playbookType, payload: { ...(e.playbookPayload ?? {}), at }, message };
          }
          if (!settled) child.stdin.write(JSON.stringify({
            t: 'res', id: frame.id, ok: false,
            error: message,
            errorType: e?.playbookType,
            errorPayload: e?.playbookPayload,
          }) + '\n');
        }
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          let frame: any;
          try { frame = JSON.parse(line); } catch { continue; }

          if (frame.t === 'cmd') void handleCommand(frame);
          else if (frame.t === 'log') opts.onLog(String(frame.message));
          else if (frame.t === 'done') finish(done({ ok: true, result: frame.result }));
          else if (frame.t === 'fail') {
            // `frame.type` and `frame.payload` are UNTRUSTED CHILD INPUT and
            // are never adopted as the result's type/payload. `wrap()` in
            // `context.ts` only strips properties on the host-method-return
            // path; a script that throws its OWN error directly (never
            // calling a `supersurf.*` method) never touches `wrap()`, so
            // anything the script set on that error — including a forged
            // `__ssType`/`__ssPayload` — reaches `child.ts`'s catch, and the
            // child, intact, verbatim. Trusting `frame.type`/`frame.payload`
            // here would let a malicious playbook fabricate an arbitrary
            // `PlaybookErrorType` and payload for the host (and Task 6) to
            // act on.
            //
            // `frame.type` is used ONLY as a boolean "did any tag survive?"
            // signal, never as a value: a compiled child may omit `type`
            // altogether (a stale/unbuilt `dist/child.js` predating any
            // tagging — see `resolveChildEntry`) or send the untagged
            // default `'ScriptAssertion'`. Both mean "no tag survived,"
            // so both are treated the same, and either way the actual
            // `type`/`payload` on the result come ONLY from
            // `lastCommandFailure` — the host's own record of a failure it
            // classified itself — never from the frame.
            //
            // Promote to the last classified command failure ONLY when the
            // message is character-identical: `wrap()` in `context.ts`
            // rethrows `new Error(String(e.message))` on the way out of the
            // vm, verified end-to-end to reproduce the host's message
            // byte-for-byte. An exact match is the whole point — a script
            // that catches a miss and deliberately throws a DIFFERENT
            // message must stay `ScriptAssertion`.
            const untyped = frame.type == null || frame.type === 'ScriptAssertion';
            const rawMessage = String(frame.message);
            // Correlate on the RAW message: `lastCommandFailure.message` is the
            // host's own uncapped string, so capping before the comparison
            // would break the byte-for-byte match the correlation depends on.
            const correlated = untyped && lastCommandFailure && rawMessage === lastCommandFailure.message
              ? lastCommandFailure
              : undefined;
            // `message` and `stack` are as untrusted as `type` — see the caps'
            // definition. Bound them here, once, before anything downstream
            // persists or renders them.
            finish(done({
              ok: false,
              error: capText(rawMessage, MAX_FAIL_MESSAGE_CHARS),
              type: correlated?.type ?? 'ScriptAssertion',
              payload: correlated?.payload,
              stack: frame.stack == null ? undefined : capText(String(frame.stack), MAX_FAIL_STACK_CHARS),
            }));
          }
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
        opts.onLog(chunk.trimEnd());
      });

      child.on('error', (e: any) => finish(done({
        ok: false,
        error: `could not start the playbook sandbox: ${e?.message ?? e}`,
        type: 'HarnessUnavailable', payload: { component: 'sandbox-child' },
      })));

      child.on('exit', (code, signal) => {
        const how = code != null ? `exit code ${code}` : `signal ${signal}`;
        const tail = stderr.trim() ? `: ${stderr.trim().split('\n').slice(-3).join(' | ')}` : '';
        finish(done({
          ok: false,
          error: `playbook sandbox exited before finishing (${how})${tail}`,
          type: 'HarnessUnavailable', payload: { component: 'sandbox-child' },
        }));
      });

      child.stdin.write(JSON.stringify({
        t: 'init',
        source,
        file: opts.file,
        meta: opts.meta,
        params: opts.params,
      }) + '\n');
    });
  })();
}
