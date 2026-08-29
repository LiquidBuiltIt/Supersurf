"use strict";
/**
 * The ONE config merge. CLI flag → env var → ~/.supersurf/config.json →
 * shared/config/defaults.ts.
 *
 * Extracted because `cli.ts` runs `program.parse()` as a top-level side effect
 * and therefore cannot be imported as a module — which is how the merge got
 * duplicated into `bin/playbook-cli.ts` in the first place. Every runner
 * (MCP server, playbook CLI, playbook script runner) imports this instead.
 *
 * @module backend-config
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
exports.cliToPartial = cliToPartial;
exports.configFilePath = configFilePath;
exports.buildConfigService = buildConfigService;
exports.backendConfigFrom = backendConfigFrom;
const path = __importStar(require("node:path"));
const os = __importStar(require("node:os"));
const shared_1 = require("./shared");
/** Translate parsed Commander options into a PartialConfig slice. */
function cliToPartial(options) {
    const out = {};
    if (options.port !== undefined)
        out.daemon = { port: Number(options.port) };
    if (options.debug === true ||
        options.debug === 'no_truncate' ||
        (typeof options.debug === 'string' && options.debug && options.debug !== 'false')) {
        out.logging = { debug: options.debug === 'no_truncate' ? 'no_truncate' : 'truncate' };
    }
    if (options.disableSecureEval)
        out.security = { ...(out.security || {}), secure_eval: false };
    if (options.disablePlaybookEval)
        out.security = { ...(out.security || {}), playbook_eval: false };
    return out;
}
/** Resolve the config file path, honouring SUPERSURF_CONFIG_FILE. */
function configFilePath() {
    return process.env.SUPERSURF_CONFIG_FILE
        || path.join(os.homedir(), '.supersurf', 'config.json');
}
/** Build a ConfigService merging CLI + env + file inputs. */
function buildConfigService(cliOptions, onWarn) {
    const { config: fileCfg, warnings: fileWarn } = (0, shared_1.loadJsonConfig)(configFilePath());
    const { config: envCfg, warnings: envWarn } = (0, shared_1.loadEnvConfig)(process.env);
    if (onWarn)
        for (const w of [...fileWarn, ...envWarn])
            onWarn(w);
    return new shared_1.ConfigService({
        cli: cliToPartial(cliOptions),
        env: envCfg,
        file: fileCfg,
        onWarn,
    });
}
/** Build a BackendConfig from a resolved ConfigService snapshot. */
function backendConfigFrom(configService, version, showUpgradeNotice = false) {
    const c = configService.get();
    return {
        debug: !!c.logging.debug,
        port: c.daemon.port,
        server: { name: 'SuperSurf', version },
        enabledExperiments: Object.entries(c.experiments)
            .filter(([k, v]) => v && k !== 'profiles')
            .map(([k]) => k),
        configService,
        showUpgradeNotice,
    };
}
//# sourceMappingURL=backend-config.js.map