"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.doValidate = exports.doInspect = exports.doList = void 0;
exports.onPlaybooks = onPlaybooks;
const trail_1 = require("../playbooks/trail");
const trail_format_1 = require("../playbooks/trail-format");
const paths_1 = require("../playbooks/paths");
const registry_1 = require("../playbooks/registry");
const runner_1 = require("../playbooks/runner");
const index_1 = require("../experimental/index");
const report_1 = require("../playbooks/report");
Object.defineProperty(exports, "doList", { enumerable: true, get: function () { return report_1.doList; } });
Object.defineProperty(exports, "doInspect", { enumerable: true, get: function () { return report_1.doInspect; } });
Object.defineProperty(exports, "doValidate", { enumerable: true, get: function () { return report_1.doValidate; } });
/** Default history window. The busiest observed real session logged 5,215 actions. */
const DEFAULT_LIMIT = 50;
function text(body, isError = false) {
    return { content: [{ type: 'text', text: body }], isError };
}
/**
 * Playbooks still require the `fingerprinting` experiment for `run`: a script's
 * selectors are as fragile as a recording's, and healing is what keeps a run
 * alive across a CSS change. `history`, `list`, `inspect` and `validate` are
 * pure reports and are never gated.
 */
function gate() {
    if (index_1.experimentRegistry.isEnabled('fingerprinting'))
        return null;
    return 'Playbook runs need the `fingerprinting` experiment, which is off.\n\n' +
        'Enable it in `~/.supersurf/config.json` under `experiments`, then restart the daemon:\n' +
        '  npx supersurf-daemon@latest restart\n\n' +
        'Without it, a script\'s selectors cannot heal when the page changes, so a run ' +
        'would break on the first CSS change.';
}
async function onPlaybooks(ctx, args, options, deps = {}) {
    switch (args.action) {
        case 'history': return doHistory(args);
        case 'list': return (0, report_1.doList)(args);
        case 'inspect': return (0, report_1.doInspect)(args);
        case 'validate': return (0, report_1.doValidate)(args);
        case 'run': return doRun(ctx, args, deps);
        case 'create':
            return text('`playbooks create` no longer exists. Playbooks are JavaScript files you write yourself.\n\n' +
                'Write `~/.supersurf/playbooks/<name>.playbook.js` with your own file tools, then:\n' +
                '  playbooks {action:"validate", name:"<name>"}\n' +
                '  playbooks {action:"run", name:"<name>", params:{…}}\n\n' +
                'Use `playbooks {action:"history"}` to read back the selectors your working run used.', true);
        default:
            return text(`Unknown playbooks action: ${JSON.stringify(args.action)}. ` +
                'Expected one of: history, list, inspect, validate, run.', true);
    }
}
function doHistory(args) {
    const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 500) : DEFAULT_LIMIT;
    const offset = typeof args.offset === 'number' && args.offset > 0 ? args.offset : 0;
    const { entries, total } = trail_1.actionTrail.tail(limit, offset);
    return text((0, trail_format_1.formatHistory)(entries, total, offset));
}
async function doRun(ctx, args, deps) {
    const blocked = gate();
    if (blocked)
        return text(blocked, true);
    const name = (0, paths_1.normalizeName)(String(args.name ?? ''));
    if (!name)
        return text('`name` is required.', true);
    const rec = (0, registry_1.getRecord)(name);
    if (!rec)
        return text(`No playbook named \`${name}\`. List them with: playbooks {action:"list"}`, true);
    if (!rec.valid || !rec.meta) {
        return text(`\`${name}\` did not validate — ${rec.error ?? 'unknown validation error'}\n\nFix the file, then re-run.`, true);
    }
    // Caller-based eval gate. This path is always an agent.
    if (rec.meta.permissions?.includes('eval')) {
        const allowed = ctx.connectionManager?.config?.configService?.get?.().security?.playbook_eval;
        if (allowed === false) {
            return text(`\`${name}\` declares the \`eval\` permission and \`security.playbook_eval\` is false, ` +
                'so agent-invoked runs are refused.\n\n' +
                'Either drop `eval` from the script\'s `@permissions`, or run it yourself after reading it:\n' +
                `  supersurf playbook run ${name}`, true);
        }
    }
    const params = (args.params && typeof args.params === 'object' && !Array.isArray(args.params))
        ? args.params
        : {};
    const profile = typeof args.profile === 'string' && args.profile.trim() ? args.profile.trim() : undefined;
    const run = deps.runPlaybook ?? runner_1.runPlaybook;
    const outcome = await run({ record: rec, params, caller: 'agent', profile });
    const lines = [];
    for (const l of outcome.logs)
        lines.push(`  ${l}`);
    if (outcome.logs.length > 0)
        lines.push('');
    if (outcome.ok) {
        lines.push(`✓ ${name} — ${outcome.durationMs}ms`);
        if (outcome.result !== undefined) {
            lines.push('');
            lines.push(typeof outcome.result === 'string' ? outcome.result : JSON.stringify(outcome.result, null, 2));
        }
        return text(lines.join('\n'));
    }
    lines.push(`✗ ${name} — ${outcome.durationMs}ms`);
    if (outcome.type) {
        const where = outcome.at ? ` at step ${outcome.at.step} (\`${outcome.at.method}\`)` : '';
        lines.push(`${outcome.type}${where}`);
    }
    lines.push(outcome.error ?? 'unknown error');
    if (outcome.evidence?.candidates?.length) {
        lines.push('');
        lines.push(`Closest elements on the page (the run's tab is already closed)`
            + `${outcome.evidence.url ? ` — ${outcome.evidence.url}` : ''}:`);
        for (const c of outcome.evidence.candidates) {
            lines.push(`  \`${c.selector}\`${c.text ? ` — "${c.text}"` : ''}`);
        }
    }
    if (outcome.stack) {
        lines.push('');
        lines.push(outcome.stack);
    }
    return text(lines.join('\n'), true);
}
//# sourceMappingURL=playbooks.js.map