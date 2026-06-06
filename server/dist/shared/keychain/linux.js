"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LinuxKeychainBackend = void 0;
const child_process_1 = require("child_process");
const types_1 = require("./types");
class LinuxKeychainBackend {
    async add(name, value, domain) {
        const args = ['store', `--label=SuperSurf: ${name}`, 'service', types_1.SUPERSURF_SERVICE, 'name', name];
        if (domain !== undefined && domain !== '') {
            args.push('domain', domain);
        }
        try {
            (0, child_process_1.execFileSync)('secret-tool', args, {
                input: value,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        }
        catch (err) {
            throw new types_1.KeychainError(`Failed to add credential '${name}'`, err);
        }
    }
    async get(name) {
        try {
            const out = (0, child_process_1.execFileSync)('secret-tool', ['lookup', 'service', types_1.SUPERSURF_SERVICE, 'name', name], { stdio: ['ignore', 'pipe', 'pipe'] });
            return out.toString('utf8').replace(/\r?\n$/, '');
        }
        catch (err) {
            if (err?.status === 1)
                return null;
            throw new types_1.KeychainError(`Failed to get credential '${name}'`, err);
        }
    }
    async list() {
        let output;
        try {
            output = (0, child_process_1.execFileSync)('secret-tool', ['search', '--all', '--unlock', 'service', types_1.SUPERSURF_SERVICE], { stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8');
        }
        catch (err) {
            if (err?.status === 1)
                return [];
            throw new types_1.KeychainError('Failed to list credentials', err);
        }
        return parseSecretToolSearch(output);
    }
    async remove(name) {
        const existing = await this.get(name);
        if (existing === null) {
            throw new types_1.KeychainError(`Credential '${name}' not found`);
        }
        try {
            (0, child_process_1.execFileSync)('secret-tool', ['clear', 'service', types_1.SUPERSURF_SERVICE, 'name', name], { stdio: ['ignore', 'pipe', 'pipe'] });
        }
        catch (err) {
            throw new types_1.KeychainError(`Failed to remove credential '${name}'`, err);
        }
    }
}
exports.LinuxKeychainBackend = LinuxKeychainBackend;
function parseSecretToolSearch(output) {
    const items = [];
    const blocks = output.split(/^\[/m).filter((b) => b.trim().length > 0);
    for (const block of blocks) {
        const nameMatch = block.match(/^attribute\.name\s*=\s*(.+)$/m);
        if (!nameMatch)
            continue;
        const domainMatch = block.match(/^attribute\.domain\s*=\s*(.+)$/m);
        const entry = { name: nameMatch[1].trim() };
        if (domainMatch && domainMatch[1].trim() !== '') {
            entry.domain = domainMatch[1].trim();
        }
        items.push(entry);
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    return items;
}
//# sourceMappingURL=linux.js.map