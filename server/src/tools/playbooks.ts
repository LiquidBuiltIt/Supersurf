/**
 * The `playbooks` MCP tool — history, create, run.
 *
 * NOT an experiment. This is core infrastructure that CHECKS the `fingerprinting`
 * experiment: `create` and `run` refuse without it, because a saved playbook whose
 * selectors cannot heal is a brittle macro, not a playbook. `history` works
 * regardless — it only reports what already happened.
 *
 * @module tools/playbooks
 */

import type { ToolContext } from './lib/types';
import type { Playbook, PlaybookStep } from '../playbooks/types';
import { actionTrail } from '../playbooks/trail';
import {
  savePlaybook, loadPlaybook, playbookExists, normalizeName, listPlaybooks,
} from '../playbooks/store';
import { formatHistory, formatInspect } from '../playbooks/format';
import { derivePlaybookDomains, normalizeDomain } from '../playbooks/domains';
import { experimentRegistry } from '../experimental/index';
import { executeAction as realExecuteAction } from './interaction/registry';
import { onNavigate as realNavigate, getAttachedUrl } from './navigation';
import { callToolHandler as realCallHandler } from './lib/handler-registry';
import { dialogNoticeLines } from './lib/dialog-notice';

/** Default history window. The busiest observed real session logged 5,215 actions. */
const DEFAULT_LIMIT = 50;

/**
 * The `browser_interact` verbs that do not heal.
 * `force_pseudo_state` drives CDP directly off a resolved `objectId`
 * (`DOM.requestNode`) rather than through `resolveInFrames`/`getCenterInFrame`,
 * so there is no fingerprint to heal against. `wait` polls for the ORIGINAL
 * selector to appear — healing a miss into a look-alike would end the wait
 * early and defeat its purpose. Every other selector-resolving verb heals
 * (see `tools/lib/frames.ts`).
 */
const UNHEALED_VERBS = new Set(['force_pseudo_state', 'wait']);

/** Seams for tests. Production passes nothing and gets the real implementations. */
export interface PlaybookDeps {
  executeAction?: (ctx: ToolContext, action: any) => Promise<string>;
  navigate?: (ctx: ToolContext, args: any, options: any) => Promise<any>;
  callHandler?: (ctx: ToolContext, name: string, args: Record<string, unknown>, options: { rawResult?: boolean }) => Promise<any | null>;
}

function text(body: string, isError = false): any {
  return { content: [{ type: 'text', text: body }], isError };
}

/** Marker `formatResult` always appends after the status header (`backend/status.ts`). */
const STATUS_HEADER_DIVIDER = '\n---\n\n';

/**
 * Handlers reached through `callHandler` route their result through
 * `ctx.formatResult`, which unconditionally prepends the connection status
 * header (version | browser | tab) for a live agent call. A replayed step
 * is not a live call — strip that header here rather than widening the
 * shared `formatResult` contract for this one caller. The divider is short
 * and always leads the string, so bail if it turns up deep in the body —
 * that's real content (e.g. a markdown rule), not our header.
 */
function stripStatusHeader(body: string): string {
  // A `_recovery` note (tab re-bound mid-call) is real content formatResult
  // prepends BEFORE the status header — pull it out before stripping so it
  // is not swallowed along with the header, then reattach it.
  const recoveryMatch = body.match(/^↻ tab recovered:[^\n]*\n/);
  const recoveryNote = recoveryMatch ? recoveryMatch[0] : '';
  const rest = recoveryNote ? body.slice(recoveryNote.length) : body;

  const idx = rest.indexOf(STATUS_HEADER_DIVIDER);
  if (idx === -1 || idx > 400) return body;
  return recoveryNote + rest.slice(idx + STATUS_HEADER_DIVIDER.length);
}

/**
 * Drain any native-dialog events buffered since the last drain and, when
 * present, attach a warning beneath the step that raised them. Replayed
 * steps bypass `dispatchTool` (they call `exec`/`callHandler` directly), so
 * without this the dialog buffer would either go unreported or leak into
 * whichever live call drains it next.
 */
function pushDialogNotice(lines: string[], ctx: ToolContext): void {
  const transport: any = ctx.ext;
  if (typeof transport?.consumeDialogEvents !== 'function') return;
  const events = transport.consumeDialogEvents();
  if (!events || events.length === 0) return;
  lines.push(...dialogNoticeLines(events));
}

function gate(): string | null {
  if (experimentRegistry.isEnabled('fingerprinting')) return null;
  return 'Playbooks need the `fingerprinting` experiment, which is off.\n\n' +
    'Enable it in `~/.supersurf/config.json` under `experiments`, then restart the daemon:\n' +
    '  npx supersurf daemon restart\n\n' +
    'Without it, saved selectors cannot heal when the page changes, so a playbook ' +
    'would break on the first CSS change.';
}

/**
 * Resolve which profile a `run` call should target: the explicit `profile`
 * arg wins, else the playbook's own `profile` field (set by `create` when the
 * recording session was profile-bound), else `undefined` (no profile).
 *
 * Exported so `backend/handlers.ts` can resolve the target profile BEFORE a
 * bridge exists — passive-state `run` needs the answer to pick a profile for
 * its implicit `connect`, and active-state `run` needs it to check for a
 * mismatch against the session's already-bound profile.
 */
export function resolveRunProfile(args: any): string | undefined {
  const explicit = typeof args.profile === 'string' && args.profile.trim() ? args.profile.trim() : undefined;
  if (explicit) return explicit;
  const name = typeof args.name === 'string' ? normalizeName(args.name) : '';
  if (!name) return undefined;
  const pb = loadPlaybook(name);
  return pb?.profile;
}

export async function onPlaybooks(
  ctx: ToolContext,
  args: any,
  options: any,
  deps: PlaybookDeps = {},
): Promise<any> {
  switch (args.action) {
    case 'history': return doHistory(args);
    case 'create':  return doCreate(ctx, args);
    case 'run':     return doRun(ctx, args, deps);
    case 'list':    return doList(args);
    case 'inspect': return doInspect(args);
    default:
      return text(
        `Unknown playbooks action: ${JSON.stringify(args.action)}. ` +
        'Expected one of: history, create, run, list, inspect.',
        true,
      );
  }
}

/**
 * `list` and `inspect` are store-only reads — no browser/extension needed —
 * so `backend.ts` calls these directly to bypass the passive-state gate.
 */
export function doList(args: any): any {
  const domainFilterRaw = typeof args.domain === 'string' ? args.domain.trim() : '';
  const domainFilter = domainFilterRaw ? normalizeDomain(domainFilterRaw) : null;

  const rows = listPlaybooks()
    .map(pb => ({ pb, domains: derivePlaybookDomains(pb.steps) }))
    .filter(({ domains }) => !domainFilter || domains.includes(domainFilter))
    .sort((a, b) => a.pb.name.localeCompare(b.pb.name));

  if (rows.length === 0) {
    return text(
      domainFilter
        ? `No playbooks match domain \`${domainFilter}\`.`
        : '(no playbooks saved)',
    );
  }

  const lines = rows.map(({ pb, domains }) => {
    const parts = [`${pb.name} — ${pb.steps.length} steps — ${pb.purpose}`];
    parts.push(`domains: ${domains.length > 0 ? domains.join(', ') : '(none)'}`);
    if (pb.profile) parts.push(`profile: ${pb.profile}`);
    return parts.join('  |  ');
  });
  return text(lines.join('\n'));
}

export function doInspect(args: any): any {
  const name = normalizeName(String(args.name ?? ''));
  if (!name) return text('`name` is required.', true);

  const pb = loadPlaybook(name);
  if (!pb) {
    return text(`No playbook named \`${name}\`. List them with: playbooks {action:"list"}`, true);
  }

  return text(formatInspect(pb, derivePlaybookDomains(pb.steps)));
}

function doHistory(args: any): any {
  const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 500) : DEFAULT_LIMIT;
  const offset = typeof args.offset === 'number' && args.offset > 0 ? args.offset : 0;
  const { entries, total } = actionTrail.tail(limit, offset);
  return text(formatHistory(entries, total, offset));
}

function doCreate(ctx: ToolContext, args: any): any {
  const blocked = gate();
  if (blocked) return text(blocked, true);

  const ids: unknown = args.steps;
  if (!Array.isArray(ids) || ids.length === 0) {
    return text('`steps` must be a non-empty array of action ids. Call `playbooks {action:"history"}` to see them.', true);
  }

  const name = normalizeName(String(args.name ?? ''));
  if (!name) return text('`name` is required.', true);

  if (playbookExists(name)) {
    return text(
      `A playbook named \`${name}\` already exists.\n\n` +
      `Remove it first, then create again:\n  supersurf playbook rm ${name}`,
      true,
    );
  }

  // Resolve every id BEFORE writing anything — a partial playbook is worse
  // than no playbook, because the agent would believe it saved the full flow.
  const steps: PlaybookStep[] = [];
  const failedIds: number[] = [];
  for (const raw of ids) {
    const id = Number(raw);
    const entry = actionTrail.get(id);
    if (!entry) {
      return text(
        `Action #${id} is not in this session's trail. Nothing was saved.\n\n` +
        'Call `playbooks {action:"history"}` to see the ids that are available.',
        true,
      );
    }
    if (entry.outcome === 'error') failedIds.push(id);
    steps.push({ tool: entry.tool, type: entry.type, params: entry.params, url: entry.url, sourceId: id });
  }

  const pb: Playbook = {
    name,
    purpose: String(args.purpose ?? ''),
    steps,
    createdAt: Date.now(),
    version: 1,
  };
  // Bind to the current session's managed profile, when there is one.
  // Absent for unmanaged sessions — `run` then falls through to a plain connect.
  const boundProfile = ctx.connectionManager?.profile;
  if (typeof boundProfile === 'string' && boundProfile) pb.profile = boundProfile;
  savePlaybook(pb);
  // The new playbook may introduce domains the status-header hint's cached
  // index doesn't know about yet — drop the cache so the next header rebuilds it.
  ctx.connectionManager?.invalidatePlaybookIndex?.();

  let body = `Saved \`${name}\` — ${steps.length} steps.`;
  if (failedIds.length > 0) {
    body += `\n\n⚠ Warning: ${failedIds.map(i => `#${i}`).join(', ')} failed when originally run. ` +
      'They were saved as cited. Edit with `supersurf playbook edit ' + name + '` if that was not intended.';
  }
  return text(body);
}

function stepOpensOwnPage(step: PlaybookStep): boolean {
  if (step.tool === 'browser_navigate') return true;
  return step.tool === 'browser_tabs' && (step.params as any)?.action === 'new';
}

async function doRun(ctx: ToolContext, args: any, deps: PlaybookDeps): Promise<any> {
  const blocked = gate();
  if (blocked) return text(blocked, true);

  const exec = deps.executeAction ?? realExecuteAction;
  const navigate = deps.navigate ?? realNavigate;
  const callHandler = deps.callHandler ?? realCallHandler;

  const name = normalizeName(String(args.name ?? ''));
  const pb = loadPlaybook(name);
  if (!pb) {
    return text(`No playbook named \`${name}\`. List them with: supersurf playbook ls`, true);
  }

  const lines: string[] = [];
  // Inline screenshot blobs from replayed `browser_take_screenshot` steps
  // (no recorded `path`) — collected in step order, appended to the MCP
  // result content after the text summary. Path-recorded steps write the
  // file only, as they already do, and add nothing here.
  const images: any[] = [];
  const total = pb.steps.length;

  // Start point: step 1's recorded URL. Read the live URL rather than the
  // cached one — the cache is not reassigned after back/forward navigation.
  // Skipped when step 1 is itself a navigate or opens a new tab: replaying it
  // lands on the right page anyway, and pre-navigating would load the URL
  // twice (or fail outright with no tab attached yet).
  const startUrl = pb.steps[0]?.url;
  if (startUrl && !stepOpensOwnPage(pb.steps[0])) {
    const current = await getAttachedUrl(ctx);
    if (current !== startUrl) {
      await navigate(ctx, { action: 'url', url: startUrl }, { rawResult: true });
      const id = actionTrail.record({
        tool: 'browser_navigate', type: 'navigate', outcome: 'ok',
        message: `Navigated to ${startUrl}`, params: { action: 'url', url: startUrl }, url: startUrl,
      });
      lines.push(`#${id} ✓ start  ${startUrl}`);
    }
  }

  for (let i = 0; i < total; i++) {
    const step = pb.steps[i];

    if (step.tool === 'browser_interact') {
      try {
        const msg = await exec(ctx, step.params);
        const id = actionTrail.record({
          tool: step.tool, type: step.type, outcome: 'ok',
          message: msg, params: step.params, url: step.url,
        });
        lines.push(`#${id} ✓ ${i + 1}/${total}  ${step.type}`);
        pushDialogNotice(lines, ctx);
      } catch (err: any) {
        const id = actionTrail.record({
          tool: step.tool, type: step.type, outcome: 'error',
          message: err.message, params: step.params, url: step.url,
        });
        lines.push(`#${id} ✗ ${i + 1}/${total}  ${step.type}`);
        lines.push(`        ${err.message}`);
        if (UNHEALED_VERBS.has(step.type)) {
          lines.push(
            `        No heal attempted — ${step.type} is not covered by healing ` +
            `(force_pseudo_state resolves raw; wait asks whether the original selector appeared).`,
          );
        }
        pushDialogNotice(lines, ctx);
        lines.push('');
        lines.push(`Stopped at step ${i + 1} of ${total}. Steps ${i + 2}-${total} not run.`);
        return text(lines.join('\n'), true);
      }
      continue;
    }

    // Generic replay: any other trail-recorded tool re-issues through the
    // shared handler registry with its frozen params. No healing (nothing
    // selector-shaped to heal) — failures report and stop, per the harness
    // principle: replay faithfully, report truthfully.
    let res: any;
    let failure: string | null = null;
    try {
      res = await callHandler(ctx, step.tool, step.params, { rawResult: false });
      if (res === null) failure = `Unknown tool: \`${step.tool}\`. This step cannot replay on this server version.`;
      else if (res.isError) failure = stripStatusHeader(res.content?.find((b: any) => b?.type === 'text')?.text ?? 'unknown error');
    } catch (err: any) {
      failure = err.message;
    }

    if (failure !== null) {
      const id = actionTrail.record({
        tool: step.tool, type: step.type, outcome: 'error',
        message: failure, params: step.params, url: step.url,
      });
      lines.push(`#${id} ✗ ${i + 1}/${total}  ${step.tool}`);
      lines.push(`        ${failure}`);
      pushDialogNotice(lines, ctx);
      lines.push('');
      lines.push(`Stopped at step ${i + 1} of ${total}. Steps ${i + 2}-${total} not run.`);
      return text(lines.join('\n'), true);
    }

    const body: string = stripStatusHeader(res.content?.find((b: any) => b?.type === 'text')?.text ?? '');
    const id = actionTrail.record({
      tool: step.tool, type: step.type, outcome: 'ok',
      message: body || 'ok', params: step.params, url: step.url,
    });
    lines.push(`#${id} ✓ ${i + 1}/${total}  ${step.tool}`);
    // Read-tool output belongs to the caller — append it in full beneath the
    // step line. The frozen params (max_lines etc.) already bound its size.
    if (body) {
      lines.push(body);
      lines.push('');
    }
    // Faithful replay of an inline screenshot: the agent originally got an
    // image block back, so a replayed run gets one too. Path-recorded steps
    // wrote a file instead and carry no image block here.
    if (Array.isArray(res.content)) {
      for (const block of res.content) {
        if (block?.type === 'image') images.push(block);
      }
    }
    pushDialogNotice(lines, ctx);
  }

  lines.push('');
  lines.push(`✓ ${pb.name} — ${total}/${total} steps.`);
  const result = text(lines.join('\n'));
  if (images.length > 0) result.content.push(...images);
  return result;
}
