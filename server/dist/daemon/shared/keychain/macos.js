"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MacosKeychainBackend = void 0;
const child_process_1 = require("child_process");
const types_1 = require("./types");
const NOT_FOUND_EXIT = 44;
class MacosKeychainBackend {
    async add(name, value, domain) {
        const args = ['add-generic-password', '-U', '-s', types_1.SUPERSURF_SERVICE, '-a', name];
        if (domain !== undefined && domain !== '') {
            args.push('-j', domain);
        }
        args.push('-w', value);
        try {
            (0, child_process_1.execFileSync)('security', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        }
        catch (err) {
            throw new types_1.KeychainError(`Failed to add credential '${name}'`, err);
        }
    }
    async get(name) {
        try {
            const out = (0, child_process_1.execFileSync)('security', ['find-generic-password', '-s', types_1.SUPERSURF_SERVICE, '-a', name, '-w'], { stdio: ['ignore', 'pipe', 'pipe'] });
            return out.toString('utf8').replace(/\r?\n$/, '');
        }
        catch (err) {
            if (err?.status === NOT_FOUND_EXIT)
                return null;
            throw new types_1.KeychainError(`Failed to get credential '${name}'`, err);
        }
    }
    async list() {
        let dump;
        try {
            dump = (0, child_process_1.execFileSync)('security', ['dump-keychain'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8');
        }
        catch (err) {
            throw new types_1.KeychainError('Failed to dump keychain', err);
        }
        return parseDumpKeychain(dump);
    }
    async remove(name) {
        try {
            (0, child_process_1.execFileSync)('security', ['delete-generic-password', '-s', types_1.SUPERSURF_SERVICE, '-a', name], { stdio: ['ignore', 'pipe', 'pipe'] });
        }
        catch (err) {
            if (err?.status === NOT_FOUND_EXIT) {
                throw new types_1.KeychainError(`Credential '${name}' not found`);
            }
            throw new types_1.KeychainError(`Failed to remove credential '${name}'`, err);
        }
    }
}
exports.MacosKeychainBackend = MacosKeychainBackend;
function parseDumpKeychain(dump) {
    const items = [];
    const blocks = dump.split(/^keychain: /m);
    for (const block of blocks) {
        if (!block.includes('class: "genp"'))
            continue;
        const svceMatch = block.match(/"svce"<blob>="([^"]*)"/);
        if (!svceMatch || svceMatch[1] !== types_1.SUPERSURF_SERVICE)
            continue;
        const acctMatch = block.match(/"acct"<blob>="([^"]*)"/);
        if (!acctMatch)
            continue;
        const cmntMatch = block.match(/"cmnt"<blob>=(?:"([^"]*)"|<NULL>)/);
        const entry = { name: acctMatch[1] };
        if (cmntMatch && cmntMatch[1] !== undefined && cmntMatch[1] !== '') {
            entry.domain = cmntMatch[1];
        }
        items.push(entry);
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    return items;
}
//# sourceMappingURL=macos.js.map