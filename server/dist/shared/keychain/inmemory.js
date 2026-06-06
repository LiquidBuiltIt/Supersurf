"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryKeychainBackend = void 0;
const types_1 = require("./types");
class InMemoryKeychainBackend {
    store = new Map();
    async add(name, value, domain) {
        this.store.set(name, { value, domain });
    }
    async get(name) {
        const entry = this.store.get(name);
        return entry ? entry.value : null;
    }
    async list() {
        const items = [];
        for (const [name, entry] of this.store.entries()) {
            const item = { name };
            if (entry.domain !== undefined)
                item.domain = entry.domain;
            items.push(item);
        }
        items.sort((a, b) => a.name.localeCompare(b.name));
        return items;
    }
    async remove(name) {
        if (!this.store.has(name)) {
            throw new types_1.KeychainError(`Credential '${name}' not found`);
        }
        this.store.delete(name);
    }
}
exports.InMemoryKeychainBackend = InMemoryKeychainBackend;
//# sourceMappingURL=inmemory.js.map