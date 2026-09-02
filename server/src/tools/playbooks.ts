/**
 * The `playbooks` MCP tool — history, list, inspect, validate, run.
 *
 * There is deliberately no `create` and no write action. SuperSurf never
 * authors a playbook file; the agent writes `*.playbook.js` with its own
 * harness's file tools. `history` is the one survivor of the recording era:
 * it reads the in-memory action trail, never the disk, so a script author can
 * read back the selectors a working run actually used.
 *
 * The `security.playbook_eval` gate is CALLER-BASED and enforced here, on the
 * agent path only. `supersurf playbook run` calls `runPlaybook` directly and
 * ignores the leaf — the untrusted party is the agent, not the human at a
 * terminal who can read the file before running it.
 *
 * @module tools/playbooks
 */

import type { ToolContext } from './lib/types';
import { actionTrail } from '../playbooks/trail';
import { formatHistory } from '../playbooks/trail-format';
import { normalizeName } from '../playbooks/paths';
import { getRecord } from '../playbooks/registry';
import { runPlaybook as realRunPlaybook, type RunOutcome } from '../playbooks/runner';
import { experimentRegistry } from '../experimental/index';
import { doList, doInspect, doValidate } from '../playbooks/report';

export { doList, doInspect, doValidate };

/** Default history window. The busiest observed real session logged 5,215 actions. */
const DEFAULT_LIMIT = 50;

/** Seam for tests. Production passes nothing and gets the real runner. */
export interface PlaybookDeps {
  runPlaybook?: (opts: any) => Promise<RunOutcome>;
}

function text(body: string, isError = false): any {
  return { content: [{ type: 'text', text: body }], isError };
}

/**
 * Playbooks still require the `fingerprinting` experiment for `run`: a script's
 * selectors are as fragile as a recording's, and healing is what keeps a run
 * alive across a CSS change. `history`, `list`, `inspect` and `validate` are
 * pure reports and are never gated.
 */
function gate(): string | null {
  if (experimentRegistry.isEnabled('fingerprinting')) return null;
  return 'Playbook runs need the `fingerprinting` experiment, which is off.\n\n' +
    'Enable it in `~/.supersurf/config.json` under `experiments`, then restart the daemon:\n' +
    '  npx supersurf-daemon@latest restart\n\n' +
    'Without it, a script\'s selectors cannot heal when the page changes, so a run ' +
    'would break on the first CSS change.';
}

export async function onPlaybooks(
  ctx: ToolContext,
  args: any,
  options: any,
  deps: PlaybookDeps = {},
): Promise<any> {
  switch (args.action) {
    case 'history':  return doHistory(args);
    case 'list':     return doList(args);
    case 'inspect':  return doInspect(args);
    case 'validate': return doValidate(args);
    case 'run':      return doRun(ctx, args, deps);
    case 'create':
      return text(
        '`playbooks create` no longer exists. Playbooks are JavaScript files you write yourself.\n\n' +
        'Write `~/.supersurf/playbooks/<name>.playbook.js` with your own file tools, then:\n' +
        '  playbooks {action:"validate", name:"<name>"}\n' +
        '  playbooks {action:"run", name:"<name>", params:{…}}\n\n' +
        'Use `playbooks {action:"history"}` to read back the selectors your working run used.',
        true,
      );
    default:
      return text(
        `Unknown playbooks action: ${JSON.stringify(args.action)}. ` +
        'Expected one of: history, list, inspect, validate, run.',
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

async function doRun(ctx: ToolContext, args: any, deps: PlaybookDeps): Promise<any> {
  const blocked = gate();
  if (blocked) return text(blocked, true);

  const name = normalizeName(String(args.name ?? ''));
  if (!name) return text('`name` is required.', true);

  const rec = getRecord(name);
  if (!rec) return text(`No playbook named \`${name}\`. List them with: playbooks {action:"list"}`, true);
  if (!rec.valid || !rec.meta) {
    return text(`\`${name}\` did not validate — ${rec.error ?? 'unknown validation error'}\n\nFix the file, then re-run.`, true);
  }

  // Caller-based eval gate. This path is always an agent.
  if (rec.meta.permissions?.includes('eval')) {
    const allowed = (ctx as any).connectionManager?.config?.configService?.get?.().security?.playbook_eval;
    if (allowed === false) {
      return text(
        `\`${name}\` declares the \`eval\` permission and \`security.playbook_eval\` is false, ` +
        'so agent-invoked runs are refused.\n\n' +
        'Either drop `eval` from the script\'s `@permissions`, or run it yourself after reading it:\n' +
        `  supersurf playbook run ${name}`,
        true,
      );
    }
  }

  const params = (args.params && typeof args.params === 'object' && !Array.isArray(args.params))
    ? args.params as Record<string, unknown>
    : {};
  const profile = typeof args.profile === 'string' && args.profile.trim() ? args.profile.trim() : undefined;

  const run = deps.runPlaybook ?? realRunPlaybook;
  const outcome = await run({ record: rec, params, caller: 'agent', profile });

  const lines: string[] = [];
  for (const l of outcome.logs) lines.push(`  ${l}`);
  if (outcome.logs.length > 0) lines.push('');

  if (outcome.ok) {
    lines.push(`✓ ${name} — ${outcome.durationMs}ms`);
    if (outcome.result !== undefined) {
      lines.push('');
      lines.push(typeof outcome.result === 'string' ? outcome.result : JSON.stringify(outcome.result, null, 2));
    }
    return text(lines.join('\n'));
  }

  lines.push(`✗ ${name} — ${outcome.durationMs}ms`);
  lines.push(outcome.error ?? 'unknown error');
  if (outcome.evidence?.snapshot) {
    lines.push('');
    lines.push('Page at the point of failure (the run\'s tab is already closed):');
    lines.push(outcome.evidence.snapshot);
  }
  return text(lines.join('\n'), true);
}
