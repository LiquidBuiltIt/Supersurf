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
exports.onPlaybooks = onPlaybooks;
exports.doList = doList;
exports.doInspect = doInspect;
exports.doValidate = doValidate;
const trail_1 = require("../playbooks/trail");
const trail_format_1 = require("../playbooks/trail-format");
const paths_1 = require("../playbooks/paths");
const registry_1 = require("../playbooks/registry");
const runs_1 = require("../playbooks/runs");
const runner_1 = require("../playbooks/runner");
const index_1 = require("../experimental/index");
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
/** Normalized host of a `meta.startingPoint`, or null. */
function startPoint(rec) {
    const raw = rec.meta?.startingPoint;
    if (typeof raw !== 'string' || !raw.trim())
        return null;
    return raw.trim().toLowerCase().replace(/^www\./, '');
}
async function onPlaybooks(ctx, args, options, deps = {}) {
    switch (args.action) {
        case 'history': return doHistory(args);
        case 'list': return doList(args);
        case 'inspect': return doInspect(args);
        case 'validate': return doValidate(args);
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
/**
 * `list`, `inspect` and `validate` are registry reads — no browser, no
 * extension — so `backend.ts` calls them directly to bypass the passive gate.
 */
function doList(args) {
    const filterRaw = typeof args.domain === 'string' ? args.domain.trim() : '';
    const filter = filterRaw ? filterRaw.toLowerCase().replace(/^www\./, '') : null;
    const rows = (0, registry_1.getRecords)().filter(r => !filter || startPoint(r) === filter);
    if (rows.length === 0) {
        return text(filter ? `No playbooks match domain \`${filter}\`.` : '(no playbooks in ~/.supersurf/playbooks/)');
    }
    const lines = rows.map(r => {
        if (!r.valid)
            return `${r.name} — ⚠ invalid: ${r.error ?? 'unknown validation error'}`;
        const parts = [`${r.signature} — ${r.meta?.description ?? ''}`];
        const sp = startPoint(r);
        if (sp)
            parts.push(`start: ${sp}`);
        if (r.meta?.profile)
            parts.push(`profile: ${r.meta.profile}`);
        if (r.meta?.permissions?.length)
            parts.push(`permissions: ${r.meta.permissions.join(', ')}`);
        parts.push((0, runs_1.formatRunSummary)((0, runs_1.readRunRecords)(r.name, 20)));
        return parts.join('  |  ');
    });
    return text(lines.join('\n'));
}
function doInspect(args) {
    const name = (0, paths_1.normalizeName)(String(args.name ?? ''));
    if (!name)
        return text('`name` is required.', true);
    const rec = (0, registry_1.getRecord)(name);
    if (!rec)
        return text(`No playbook named \`${name}\`. List them with: playbooks {action:"list"}`, true);
    const lines = [`${name} — ${rec.file}`];
    if (!rec.valid) {
        lines.push(`⚠ invalid: ${rec.error ?? 'unknown validation error'}`);
        return text(lines.join('\n'), true);
    }
    lines.push(rec.signature);
    lines.push(rec.meta?.description ?? '');
    const sp = startPoint(rec);
    if (sp)
        lines.push(`start: ${sp}`);
    if (rec.meta?.profile)
        lines.push(`profile: ${rec.meta.profile} (default — override with the \`profile\` arg)`);
    if (rec.meta?.permissions?.length)
        lines.push(`permissions: ${rec.meta.permissions.join(', ')}`);
    const spec = rec.meta?.params ?? {};
    const keys = Object.keys(spec);
    if (keys.length > 0) {
        lines.push('');
        lines.push('params:');
        for (const k of keys) {
            const d = spec[k];
            lines.push(`  ${k}: ${d.type}${d.required ? ' (required)' : ''}${d.description ? ` — ${d.description}` : ''}`);
        }
    }
    const runs = (0, runs_1.readRunRecords)(name, 5);
    lines.push('');
    lines.push(`runs: ${(0, runs_1.formatRunSummary)(runs)}`);
    for (const r of runs) {
        const mark = r.ok ? '✓' : '✗';
        lines.push(`  ${mark} ${new Date(r.ts).toISOString()}  ${r.durationMs}ms  ${r.caller}${r.ok ? '' : `  ${r.error ?? ''}`}`);
    }
    return text(lines.join('\n'));
}
function doValidate(args) {
    const name = typeof args.name === 'string' && args.name.trim() ? (0, paths_1.normalizeName)(args.name) : null;
    if (name) {
        const rec = (0, registry_1.getRecord)(name);
        if (!rec)
            return text(`No playbook named \`${name}\`. List them with: playbooks {action:"list"}`, true);
        return rec.valid
            ? text(`✓ ${rec.name} — ${rec.signature}`)
            : text(`✗ ${rec.name} — ${rec.error ?? 'unknown validation error'}`, true);
    }
    const all = (0, registry_1.getRecords)();
    if (all.length === 0)
        return text('(no playbooks in ~/.supersurf/playbooks/)');
    const lines = all.map(r => (r.valid ? `✓ ${r.name} — ${r.signature}` : `✗ ${r.name} — ${r.error ?? 'unknown validation error'}`));
    const bad = all.filter(r => !r.valid).length;
    return text(lines.join('\n'), bad > 0);
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
    lines.push(outcome.error ?? 'unknown error');
    if (outcome.evidence?.snapshot) {
        lines.push('');
        lines.push('Page at the point of failure (the run\'s tab is already closed):');
        lines.push(outcome.evidence.snapshot);
    }
    return text(lines.join('\n'), true);
}
//# sourceMappingURL=playbooks.js.map