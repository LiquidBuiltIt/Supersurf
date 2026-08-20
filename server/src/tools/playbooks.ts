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

/** Default history window. The busiest observed real session logged 5,215 actions. */
const DEFAULT_LIMIT = 50;

/**
 * Verbs whose selector resolution runs through the healed path
 * (`ctx.getElementCenter` → `resolveWithHealing`). Every other verb resolves raw.
 * Widening this is a separate chore — until then a run must SAY when a step
 * failed without a heal attempt, so the asymmetry reads as known, not broken.
 */
const HEALED_VERBS = new Set(['click', 'hover', 'drag']);

/** Seams for tests. Production passes nothing and gets the real implementations. */
export interface PlaybookDeps {
  executeAction?: (ctx: ToolContext, action: any) => Promise<string>;
  navigate?: (ctx: ToolContext, args: any, options: any) => Promise<any>;
}

function text(body: string, isError = false): any {
  return { content: [{ type: 'text', text: body }], isError };
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
    if (entry.tool !== 'browser_interact') {
      return text(
        `Action #${id} is a \`${entry.tool}\` call, not a browser_interact action. Nothing was saved.\n\n` +
        'Playbooks currently replay `browser_interact` actions only — cite the numbered ' +
        '`#N ✓ <verb>:`-style interact action ids from `playbooks {action:"history"}`, not per-call tool ids.',
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

async function doRun(ctx: ToolContext, args: any, deps: PlaybookDeps): Promise<any> {
  const blocked = gate();
  if (blocked) return text(blocked, true);

  const exec = deps.executeAction ?? realExecuteAction;
  const navigate = deps.navigate ?? realNavigate;

  const name = normalizeName(String(args.name ?? ''));
  const pb = loadPlaybook(name);
  if (!pb) {
    return text(`No playbook named \`${name}\`. List them with: supersurf playbook ls`, true);
  }

  const lines: string[] = [];
  const total = pb.steps.length;

  // Start point: step 1's recorded URL. Read the live URL rather than the
  // cached one — the cache is not reassigned after back/forward navigation.
  const startUrl = pb.steps[0]?.url;
  if (startUrl) {
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

    // Imported playbook files bypass create's validation, so a non-interact
    // step can reach run directly. executeAction only knows interact verbs —
    // fail it here with an accurate cause instead of letting it throw
    // "Unknown action type" and get mislabeled as a heal-eligible failure.
    if (step.tool !== 'browser_interact') {
      const message = `Playbooks can only replay \`browser_interact\` actions; this step is \`${step.tool}\`.`;
      const id = actionTrail.record({
        tool: step.tool, type: step.type, outcome: 'error',
        message, params: step.params, url: step.url,
      });
      lines.push(`#${id} ✗ ${i + 1}/${total}  ${step.type}`);
      lines.push(`        ${message}`);
      lines.push('');
      lines.push(`Stopped at step ${i + 1} of ${total}. Steps ${i + 2}-${total} not run.`);
      return text(lines.join('\n'), true);
    }

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
      if (!HEALED_VERBS.has(step.type)) {
        lines.push(
          `        No heal attempted — healing currently covers ` +
          `${[...HEALED_VERBS].join('/')} only.`,
        );
      }
      lines.push('');
      lines.push(`Stopped at step ${i + 1} of ${total}. Steps ${i + 2}-${total} not run.`);
      return text(lines.join('\n'), true);
    }
  }

  lines.push('');
  lines.push(`✓ ${pb.name} — ${total}/${total} steps.`);
  return text(lines.join('\n'));
}
