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
  savePlaybook, loadPlaybook, playbookExists, normalizeName,
} from '../playbooks/store';
import { formatHistory } from '../playbooks/format';
import { experimentRegistry } from '../experimental/index';
import { executeAction as realExecuteAction } from './interaction/registry';
import { onNavigate as realNavigate, getAttachedUrl } from './navigation';
import { callToolHandler as realCallHandler } from './lib/handler-registry';

/** Default history window. The busiest observed real session logged 5,215 actions. */
const DEFAULT_LIMIT = 50;

/**
 * The one `browser_interact` verb whose selector resolution stays raw.
 * `force_pseudo_state` drives CDP directly off a resolved `objectId`
 * (`DOM.requestNode`) rather than through `resolveInFrames`/`getCenterInFrame`,
 * so there is no fingerprint to heal against. Every other selector-resolving
 * verb heals (see `tools/lib/frames.ts`).
 */
const UNHEALED_VERB = 'force_pseudo_state';

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
  const idx = body.indexOf(STATUS_HEADER_DIVIDER);
  if (idx === -1 || idx > 400) return body;
  return body.slice(idx + STATUS_HEADER_DIVIDER.length);
}

function gate(): string | null {
  if (experimentRegistry.isEnabled('fingerprinting')) return null;
  return 'Playbooks need the `fingerprinting` experiment, which is off.\n\n' +
    'Enable it in `~/.supersurf/config.json` under `experiments`, then restart the daemon:\n' +
    '  npx supersurf daemon restart\n\n' +
    'Without it, saved selectors cannot heal when the page changes, so a playbook ' +
    'would break on the first CSS change.';
}

export async function onPlaybooks(
  ctx: ToolContext,
  args: any,
  options: any,
  deps: PlaybookDeps = {},
): Promise<any> {
  switch (args.action) {
    case 'history': return doHistory(args);
    case 'create':  return doCreate(args);
    case 'run':     return doRun(ctx, args, deps);
    default:
      return text(
        `Unknown playbooks action: ${JSON.stringify(args.action)}. ` +
        'Expected one of: history, create, run.',
        true,
      );
  }
}

function doHistory(args: any): any {
  const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 500) : DEFAULT_LIMIT;
  const offset = typeof args.offset === 'number' && args.offset > 0 ? args.offset : 0;
  const { entries, total } = actionTrail.tail(limit, offset);
  return text(formatHistory(entries, total, offset));
}

function doCreate(args: any): any {
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
  savePlaybook(pb);

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
      } catch (err: any) {
        const id = actionTrail.record({
          tool: step.tool, type: step.type, outcome: 'error',
          message: err.message, params: step.params, url: step.url,
        });
        lines.push(`#${id} ✗ ${i + 1}/${total}  ${step.type}`);
        lines.push(`        ${err.message}`);
        if (step.type === UNHEALED_VERB) {
          lines.push(
            `        No heal attempted — ${UNHEALED_VERB} resolves selectors raw ` +
            `and is not covered by healing.`,
          );
        }
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
  }

  lines.push('');
  lines.push(`✓ ${pb.name} — ${total}/${total} steps.`);
  return text(lines.join('\n'));
}
