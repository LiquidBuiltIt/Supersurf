#!/usr/bin/env node
"use strict";
/**
 * `supersurf playbook` — discover, validate, run and migrate playbook scripts.
 *
 * `ls`/`inspect`/`validate` are daemon-free by design, modelled on `creds.ts`
 * rather than `profiles-cli.ts`: they must work with no daemon running and no
 * browser connected. There is no `create` and no `edit`: a playbook is a
 * JavaScript file, so it is written with an editor, removed with `rm`, and
 * copied with `cp`.
 *
 * `run` at a terminal IGNORES `security.playbook_eval`. That gate exists
 * because an agent is an untrusted caller; the human running this command can
 * read the file first, so gating them would be theatre.
 *
 * @module bin/playbook-cli
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildPlaybookProgram = buildPlaybookProgram;
exports.runLs = runLs;
exports.runInspect = runInspect;
exports.runValidate = runValidate;
exports.parseParamFlags = parseParamFlags;
exports.runRun = runRun;
exports.runPlaybookProgram = runPlaybookProgram;
const commander_1 = require("commander");
const paths_1 = require("../playbooks/paths");
const registry_1 = require("../playbooks/registry");
const playbooks_1 = require("../tools/playbooks");
const runner_1 = require("../playbooks/runner");
const migrate_1 = require("../playbooks/migrate");
/** Pull the single text block out of a `playbooks` tool result. */
function body(res) {
    return String(res?.content?.find((b) => b?.type === 'text')?.text ?? '');
}
function buildPlaybookProgram() {
    const program = new commander_1.Command();
    program
        .name('supersurf playbook')
        .description('Discover, validate, run and migrate SuperSurf playbook scripts');
    program
        .command('ls')
        .description('List playbook scripts with their call signatures')
        .action(async () => { await runLs(); });
    program
        .command('inspect')
        .description('Print one script\'s params, permissions and run history')
        .argument('<name>', 'playbook name')
        .action(async (name) => { process.exitCode = await runInspect(name); });
    program
        .command('validate')
        .description('Re-check one script, or every script when no name is given')
        .argument('[name]', 'playbook name')
        .action(async (name) => { process.exitCode = await runValidate(name); });
    program
        .command('run')
        .description('Run a playbook script against a browser (no MCP client needed)')
        .argument('<name>', 'playbook name')
        .option('--param <key=value>', 'script argument; repeat for each param', (v, acc) => acc.concat(v), [])
        .option('--profile <profile>', 'managed browser profile; overrides the script\'s own default')
        .option('--json', 'print machine-readable JSON instead of the run trail')
        .action(async (name, flags) => { process.exitCode = await runRun(name, flags); });
    program
        .command('migrate')
        .description('One-shot: convert legacy JSON playbooks to .playbook.js and report what needs hand-finishing')
        .option('--dry-run', 'report what would be written without writing anything')
        .action(async (flags) => { process.exitCode = await (0, migrate_1.runMigrate)(flags); });
    return program;
}
async function runLs(opts = {}) {
    const log = opts.log ?? console.log;
    await (0, registry_1.refreshRegistry)();
    log(body((0, playbooks_1.doList)({})));
}
async function runInspect(name, opts = {}) {
    const log = opts.log ?? console.log;
    const errLog = opts.errLog ?? console.error;
    await (0, registry_1.refreshRegistry)();
    const res = (0, playbooks_1.doInspect)({ name });
    if (res.isError) {
        errLog(body(res));
        return 1;
    }
    log(body(res));
    return 0;
}
async function runValidate(name, opts = {}) {
    const log = opts.log ?? console.log;
    const errLog = opts.errLog ?? console.error;
    await (0, registry_1.refreshRegistry)();
    const res = (0, playbooks_1.doValidate)(name ? { name } : {});
    (res.isError ? errLog : log)(body(res));
    return res.isError ? 1 : 0;
}
/**
 * Turn repeated `--param key=value` flags into a params object, coercing to
 * the type `meta` declares. An undeclared key stays a string on purpose:
 * `validateParams` rejects it by name, which is a better error than a coercion
 * failure on a param that does not exist.
 */
function parseParamFlags(pairs, meta) {
    const spec = meta.params ?? {};
    const params = {};
    for (const pair of pairs) {
        const eq = pair.indexOf('=');
        if (eq <= 0)
            return { error: `--param expects key=value, got \`${pair}\`` };
        const key = pair.slice(0, eq);
        const raw = pair.slice(eq + 1);
        const type = spec[key]?.type;
        if (type === 'number') {
            const n = Number(raw);
            if (!Number.isFinite(n))
                return { error: `--param ${key}: expected a number, got \`${raw}\`` };
            params[key] = n;
        }
        else if (type === 'boolean') {
            if (raw !== 'true' && raw !== 'false')
                return { error: `--param ${key}: expected true or false, got \`${raw}\`` };
            params[key] = raw === 'true';
        }
        else {
            params[key] = raw;
        }
    }
    return { params };
}
async function runRun(name, flags, opts = {}) {
    const log = opts.log ?? console.log;
    const errLog = opts.errLog ?? console.error;
    const run = opts.runPlaybook ?? runner_1.runPlaybook;
    const normalized = (0, paths_1.normalizeName)(name);
    await (0, registry_1.refreshRegistry)();
    const record = (0, registry_1.getRecord)(normalized);
    if (!record) {
        errLog(`[playbook] No playbook named '${normalized}' in ${(0, paths_1.getPlaybooksDir)()}. List them with: supersurf playbook ls`);
        return 1;
    }
    if (!record.valid || !record.meta) {
        errLog(`[playbook] '${normalized}' did not validate — ${record.error ?? 'unknown validation error'}`);
        return 1;
    }
    const parsed = parseParamFlags(flags.param ?? [], record.meta);
    if (parsed.error) {
        errLog(`[playbook] ${parsed.error}`);
        return 1;
    }
    // No `security.playbook_eval` check here, deliberately — see the module docblock.
    const outcome = await run({
        record,
        params: parsed.params,
        caller: 'cli',
        profile: flags.profile,
        onLog: flags.json ? undefined : (m) => log(`  ${m}`),
    });
    if (flags.json) {
        log(JSON.stringify({
            name: normalized, ok: outcome.ok, durationMs: outcome.durationMs,
            ...(outcome.result !== undefined ? { result: outcome.result } : {}),
            ...(outcome.error ? { error: outcome.error } : {}),
            ...(outcome.evidence ? { evidence: outcome.evidence } : {}),
        }));
        return outcome.ok ? 0 : 1;
    }
    if (outcome.ok) {
        log(`✓ ${normalized} — ${outcome.durationMs}ms`);
        if (outcome.result !== undefined) {
            log(typeof outcome.result === 'string' ? outcome.result : JSON.stringify(outcome.result, null, 2));
        }
        return 0;
    }
    errLog(`✗ ${normalized} — ${outcome.durationMs}ms`);
    errLog(outcome.error ?? 'unknown error');
    if (outcome.evidence?.snapshot) {
        errLog('Page at the point of failure (the run\'s tab is already closed):');
        errLog(outcome.evidence.snapshot);
    }
    return 1;
}
async function runPlaybookProgram(argv) {
    const program = buildPlaybookProgram();
    try {
        await program.parseAsync(argv);
    }
    catch (err) {
        console.error(`[playbook] ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
}
if (require.main === module) {
    runPlaybookProgram(process.argv).catch(() => {
        // error already printed in runPlaybookProgram
    });
}
//# sourceMappingURL=playbook-cli.js.map