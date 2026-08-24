#!/usr/bin/env node
"use strict";
/**
 * `supersurf playbook` — manage saved playbooks.
 *
 * File management (`ls`/`show`/`edit`/`rm`/`export`/`import`) is daemon-free
 * by design, modelled on `creds.ts` rather than `profiles-cli.ts`: it must
 * work with no daemon running and no browser connected. Creation is
 * deliberately absent — playbooks are built from action ids that live in the
 * agent's context, not in the user's terminal.
 *
 * `run` is the one command that needs a live browser: it drives the same
 * `ConnectionManager` the MCP server and `--script-mode` use (see
 * `stdio.ts`), in-process, so there is exactly one playbook runner — the
 * `playbooks` MCP tool — regardless of caller.
 *
 * @module bin/playbook-cli
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildPlaybookProgram = buildPlaybookProgram;
exports.runLs = runLs;
exports.runShow = runShow;
exports.runEdit = runEdit;
exports.runRm = runRm;
exports.runExport = runExport;
exports.runImport = runImport;
exports.runRun = runRun;
exports.runPlaybookProgram = runPlaybookProgram;
const commander_1 = require("commander");
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const os = __importStar(require("node:os"));
const node_child_process_1 = require("node:child_process");
const store_1 = require("../playbooks/store");
const format_1 = require("../playbooks/format");
const backend_1 = require("../backend");
const shared_1 = require("../shared");
const { version: PACKAGE_VERSION } = require('../../package.json');
function defaultSpawnEditor(cmd, args) {
    const result = (0, node_child_process_1.spawnSync)(cmd, args, { stdio: 'inherit' });
    return { status: result.status, error: result.error };
}
function buildPlaybookProgram() {
    const program = new commander_1.Command();
    program
        .name('supersurf playbook')
        .description('Manage saved SuperSurf playbooks');
    program
        .command('ls')
        .description('List saved playbooks')
        .action(async () => { await runLs(); });
    program
        .command('show')
        .description('Print a playbook\'s steps')
        .argument('<name>', 'playbook name')
        .action(async (name) => { await runShow(name); });
    program
        .command('edit')
        .description('Open a playbook in $EDITOR, or drop a step with --drop')
        .argument('<name>', 'playbook name')
        .option('--drop <step>', 'step number to remove (1-based, as shown by `show`)')
        .action(async (name, opts) => { await runEdit(name, opts); });
    program
        .command('rm')
        .description('Remove a playbook')
        .argument('<name>', 'playbook name')
        .action(async (name) => { await runRm(name); });
    program
        .command('export')
        .description('Write a playbook to a file')
        .argument('<name>', 'playbook name')
        .argument('<file>', 'destination path')
        .action(async (name, file) => { await runExport(name, file); });
    program
        .command('import')
        .description('Read a playbook from a file')
        .argument('<file>', 'source path')
        .action(async (file) => { await runImport(file); });
    program
        .command('run')
        .description('Run a saved playbook against a connected browser (no MCP client needed)')
        .argument('<name>', 'playbook name')
        .option('--profile <profile>', 'managed browser profile to connect to')
        .option('--json', 'print machine-readable JSON instead of the run trail')
        .action(async (name, opts) => {
        process.exitCode = await runRun(name, opts);
    });
    return program;
}
async function runLs(opts = {}) {
    const log = opts.log ?? console.log;
    const all = (0, store_1.listPlaybooks)();
    if (all.length === 0) {
        log('(no playbooks saved)');
        return;
    }
    const nameWidth = Math.max(4, ...all.map(p => p.name.length));
    const header = `${'Name'.padEnd(nameWidth)}  Steps  Purpose`;
    log(header);
    log('-'.repeat(header.length));
    for (const p of all.sort((a, b) => a.name.localeCompare(b.name))) {
        log(`${p.name.padEnd(nameWidth)}  ${String(p.steps.length).padStart(5)}  ${p.purpose}`);
    }
}
async function runShow(name, opts = {}) {
    const log = opts.log ?? console.log;
    const pb = (0, store_1.loadPlaybook)(name);
    if (!pb)
        throw new Error(`No playbook named '${name}'`);
    log((0, format_1.formatSteps)(pb));
}
async function runEdit(name, flags, opts = {}) {
    const log = opts.log ?? console.log;
    if (flags.drop !== undefined) {
        const pb = (0, store_1.loadPlaybook)(name);
        if (!pb)
            throw new Error(`No playbook named '${name}'`);
        const n = Number(flags.drop);
        if (!Number.isInteger(n) || n < 1 || n > pb.steps.length) {
            throw new Error(`Step ${flags.drop} is out of range — '${name}' has ${pb.steps.length} steps`);
        }
        if (pb.steps.length === 1) {
            throw new Error(`'${name}' has only one step. Remove the playbook instead: supersurf playbook rm ${name}`);
        }
        const [dropped] = pb.steps.splice(n - 1, 1);
        (0, store_1.savePlaybook)(pb);
        log(`Dropped step ${n} (${dropped.type}) from '${pb.name}'. ${pb.steps.length} steps remain.`);
        return;
    }
    const normalized = (0, store_1.normalizeName)(name);
    const filePath = path.join((0, store_1.getBaseDir)(), `${normalized}.json`);
    const isTTY = opts.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (!isTTY) {
        throw new Error(`No terminal attached. Pass --drop <step>, edit the file directly at ${filePath}, ` +
            'or run in an interactive shell to edit in $EDITOR.');
    }
    const editorCmd = process.env.VISUAL || process.env.EDITOR;
    if (!editorCmd) {
        throw new Error("No editor is configured. Set $EDITOR (or $VISUAL) to use 'playbook edit', " +
            `or edit the playbook file directly at ${filePath}, or use --drop <step>.`);
    }
    const pb = (0, store_1.loadPlaybook)(name);
    if (!pb)
        throw new Error(`No playbook named '${name}'`);
    const original = JSON.stringify(pb, null, 2);
    const tmpPath = path.join(os.tmpdir(), `supersurf-playbook-${normalized}-${process.pid}.json`);
    fs.writeFileSync(tmpPath, original, { mode: 0o600 });
    const [cmd, ...editorArgs] = editorCmd.split(/\s+/).filter(Boolean);
    const spawnEditor = opts.spawnEditor ?? defaultSpawnEditor;
    const result = spawnEditor(cmd, [...editorArgs, tmpPath]);
    const { status, error } = typeof result === 'number' ? { status: result, error: undefined } : result;
    if (error) {
        fs.rmSync(tmpPath, { force: true });
        throw new Error(`Could not launch editor '${editorCmd}': ${error.message}. ` +
            `Edit the file directly at ${filePath}, or pass --drop <step>.`);
    }
    if (status !== 0) {
        fs.rmSync(tmpPath, { force: true });
        throw new Error(`Editor exited with status ${status}; playbook unchanged.`);
    }
    const edited = fs.readFileSync(tmpPath, 'utf8');
    if (edited === original) {
        fs.rmSync(tmpPath, { force: true });
        log(`No changes to '${normalized}'.`);
        return;
    }
    let parsed;
    try {
        parsed = JSON.parse(edited);
    }
    catch (err) {
        throw new Error(`Edited file is not valid JSON: ${err instanceof Error ? err.message : String(err)}. Your edit is kept at ${tmpPath}.`);
    }
    if (!parsed || typeof parsed !== 'object' ||
        !Array.isArray(parsed.steps) || parsed.steps.length === 0 ||
        parsed.version !== 1) {
        throw new Error(`Edited file is not a playbook (expected version 1 and a non-empty steps array). Your edit is kept at ${tmpPath}.`);
    }
    if (typeof parsed.name === 'string' && (0, store_1.normalizeName)(parsed.name) !== normalized) {
        log(`Name is fixed to '${normalized}'; use export/import to rename.`);
    }
    parsed.name = normalized;
    (0, store_1.savePlaybook)(parsed);
    fs.rmSync(tmpPath, { force: true });
    log(`Saved '${normalized}' (${parsed.steps.length} steps).`);
}
async function runRm(name, opts = {}) {
    const log = opts.log ?? console.log;
    if (!(0, store_1.removePlaybook)(name))
        throw new Error(`No playbook named '${name}'`);
    log(`Removed playbook '${(0, store_1.normalizeName)(name)}'`);
}
async function runExport(name, file, opts = {}) {
    const log = opts.log ?? console.log;
    const pb = (0, store_1.loadPlaybook)(name);
    if (!pb)
        throw new Error(`No playbook named '${name}'`);
    fs.writeFileSync(file, JSON.stringify(pb, null, 2), { mode: 0o600 });
    log(`Exported '${pb.name}' (${pb.steps.length} steps) to ${file}`);
}
async function runImport(file, opts = {}) {
    const log = opts.log ?? console.log;
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch (err) {
        throw new Error(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!parsed || typeof parsed.name !== 'string' || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
        throw new Error(`${file} is not a playbook (expected a name and a non-empty steps array)`);
    }
    if ((0, store_1.playbookExists)(parsed.name)) {
        throw new Error(`A playbook named '${(0, store_1.normalizeName)(parsed.name)}' already exists. ` +
            `Remove it first: supersurf playbook rm ${(0, store_1.normalizeName)(parsed.name)}`);
    }
    (0, store_1.savePlaybook)({ ...parsed, name: (0, store_1.normalizeName)(parsed.name), version: 1 });
    log(`Imported '${(0, store_1.normalizeName)(parsed.name)}' (${parsed.steps.length} steps)`);
}
/**
 * Build a `BackendConfig` from CLI-less config resolution (env + `~/.supersurf/config.json`
 * + hardcoded defaults) — the same merge `cli.ts`'s `buildConfig`/`backendConfigFrom` do,
 * duplicated here rather than imported because `cli.ts` runs `program.parse()` as a
 * top-level side effect and can't be safely imported as a module.
 */
function buildBackendConfig() {
    const configPath = process.env.SUPERSURF_CONFIG_FILE
        || path.join(os.homedir(), '.supersurf', 'config.json');
    const { config: fileCfg } = (0, shared_1.loadJsonConfig)(configPath);
    const { config: envCfg } = (0, shared_1.loadEnvConfig)(process.env);
    const configService = new shared_1.ConfigService({ cli: {}, env: envCfg, file: fileCfg });
    const c = configService.get();
    return {
        debug: !!c.logging.debug,
        port: c.daemon.port,
        server: { name: 'SuperSurf', version: PACKAGE_VERSION },
        enabledExperiments: Object.entries(c.experiments)
            .filter(([k, v]) => v && k !== 'profiles')
            .map(([k]) => k),
        configService,
    };
}
function defaultCreateBackend() {
    return new backend_1.ConnectionManager(buildBackendConfig());
}
/**
 * Run a saved playbook end-to-end: connect, call the `playbooks` MCP tool with
 * `{action:'run', name}`, print its result, then disconnect. Always disconnects —
 * on a failed step, a connect failure, an unexpected error, or SIGINT — because a
 * left-open session pins the daemon (and, for a managed profile, the browser) alive.
 *
 * Returns the process exit code rather than throwing, so a reported failed step
 * (not a bug — a normal "the playbook broke on step 3" outcome) prints its own
 * trail instead of being flattened into the generic `[playbook] <message>` shape
 * `runPlaybookProgram`'s catch-all uses for actual exceptions.
 */
async function runRun(name, flags, opts = {}) {
    const log = opts.log ?? console.log;
    const errLog = opts.errLog ?? console.error;
    const normalized = (0, store_1.normalizeName)(name);
    const pb = (0, store_1.loadPlaybook)(normalized);
    if (!pb) {
        errLog(`[playbook] No playbook named '${normalized}'. List them with: supersurf playbook ls`);
        return 1;
    }
    // Resolution order: --profile flag, then the playbook's own optional
    // `profile` field (a parallel branch is adding this to the schema — read
    // it defensively, don't assume the type declares it yet), then none.
    const profile = flags.profile ?? (typeof pb.profile === 'string' ? pb.profile : undefined);
    const backend = (opts.createBackend ?? defaultCreateBackend)();
    let disconnectStarted = false;
    const disconnect = async () => {
        if (disconnectStarted)
            return;
        disconnectStarted = true;
        try {
            await backend.callTool('disconnect', {}, { rawResult: true });
        }
        catch {
            // Best-effort — we're already on our way out.
        }
    };
    const onSigint = () => {
        void disconnect().finally(() => process.exit(1));
    };
    process.once('SIGINT', onSigint);
    try {
        const connectArgs = { client_id: `playbook-run-${process.pid}` };
        if (profile)
            connectArgs.profile = profile;
        const connectResult = await backend.callTool('connect', connectArgs, { rawResult: true });
        if (!connectResult?.success) {
            errLog(`[playbook] Connect failed: ${connectResult?.message ?? 'unknown error'}`);
            return 1;
        }
        const runResult = await backend.callTool('playbooks', { action: 'run', name: normalized }, { rawResult: true });
        const body = String(runResult?.content?.find((b) => b?.type === 'text')?.text ?? '');
        const failed = Boolean(runResult?.isError);
        if (flags.json) {
            log(JSON.stringify({ name: normalized, success: !failed, output: body }));
        }
        else if (failed) {
            errLog(body);
        }
        else {
            log(body);
        }
        return failed ? 1 : 0;
    }
    catch (err) {
        errLog(`[playbook] ${err instanceof Error ? err.message : String(err)}`);
        return 1;
    }
    finally {
        await disconnect();
        process.off('SIGINT', onSigint);
    }
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