"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.devSource = devSource;
/**
 * Dev-environment router.
 *
 * `SUPERSURF_DEV_ENVIRONMENT=<repo root>` makes each component run a clone's
 * code instead of the code it shipped with. `null` means "use what you
 * shipped with": the var is unset, or the clone cannot serve this component.
 * The second case says why on stderr — never stdout, which `supersurf mcp`
 * owns as its JSON-RPC stream.
 *
 * @module dev-source
 */
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const ENTRY = {
    server: 'server/dist/cli.js',
    daemon: 'daemon/dist/main.js',
    extension: 'extension',
};
function sameFile(a, b) {
    try {
        return !!b && fs_1.default.realpathSync(a) === fs_1.default.realpathSync(b);
    }
    catch {
        return false;
    }
}
function devSource(component) {
    const raw = process.env.SUPERSURF_DEV_ENVIRONMENT;
    if (!raw)
        return null;
    const root = path_1.default.resolve(raw);
    const target = path_1.default.join(root, ENTRY[component]);
    let problem = null;
    try {
        const name = JSON.parse(fs_1.default.readFileSync(path_1.default.join(root, 'package.json'), 'utf8')).name;
        if (name !== 'supersurf')
            problem = `${root} is not a SuperSurf repo root (package.json name is "${name}")`;
    }
    catch {
        problem = `${root} is not a SuperSurf repo root (no readable package.json)`;
    }
    const probe = component === 'extension' ? path_1.default.join(target, 'manifest.json') : target;
    if (!problem && !fs_1.default.existsSync(probe)) {
        problem = `${path_1.default.relative(root, probe)} is missing. Run npm run build in ${root}`;
    }
    if (problem) {
        console.error(`[supersurf] SUPERSURF_DEV_ENVIRONMENT: ${problem}. Using the packaged ${component} instead.`);
        return null;
    }
    // The running entry already is the dev build; routing it again would loop.
    if (sameFile(target, process.argv[1]))
        return null;
    return target;
}
//# sourceMappingURL=dev-source.js.map