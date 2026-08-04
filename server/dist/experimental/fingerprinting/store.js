"use strict";
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
exports.setBaseDirForTests = setBaseDirForTests;
exports.loadDomain = loadDomain;
exports.saveDomain = saveDomain;
exports.getRecord = getRecord;
exports.putRecord = putRecord;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const os = __importStar(require("node:os"));
let baseDir = path.join(os.homedir(), '.supersurf', 'fingerprints');
/**
 * Parsed-domain memo, keyed by absolute file path.
 *
 * Guarded by mtime AND size rather than write-through invalidation: each MCP client
 * runs its own server process and several can target the same domain file, so a
 * write-through-only cache would serve another process's stale parse indefinitely.
 * `statSync` is one syscall with no parse; `size` covers the case where two writes
 * land inside the same filesystem mtime granularity.
 */
const cache = new Map();
/** Test-only override of the storage directory. Clears the memo. */
function setBaseDirForTests(dir) {
    baseDir = dir;
    cache.clear();
}
function domainFile(domain) {
    // domain is a hostname; safe as a filename. Strip anything odd defensively.
    const safe = domain.replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(baseDir, `${safe}.json`);
}
/**
 * Read a domain store, reusing the last parse when the file on disk is unchanged.
 *
 * CONTRACT: the returned object is the cached instance, not a copy. Treat it as
 * read-only — mutate a store only via `putRecord`, which saves and refreshes the
 * memo in the same breath. Mutating without saving poisons the cache.
 */
function loadDomain(domain) {
    const file = domainFile(domain);
    try {
        const st = fs.statSync(file);
        const hit = cache.get(file);
        if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size)
            return hit.data;
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, data });
        return data;
    }
    catch {
        // Missing or unparseable: drop any memo so a later valid write is picked up.
        cache.delete(file);
        return { domain, routes: {} };
    }
}
function saveDomain(store) {
    fs.mkdirSync(baseDir, { recursive: true });
    const file = domainFile(store.domain);
    fs.writeFileSync(file, JSON.stringify(store, null, 2));
    try {
        const st = fs.statSync(file);
        cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, data: store });
    }
    catch {
        cache.delete(file);
    }
}
/** Returns the live cached record (same read-only contract as `loadDomain`) — mutate
 *  only via `putRecord`, never in place, or the in-process memo goes stale. */
function getRecord(domain, route, selector) {
    const store = loadDomain(domain);
    const byRoute = store.routes[route];
    return byRoute ? byRoute[selector] : undefined;
}
function putRecord(domain, route, selector, rec) {
    const store = loadDomain(domain);
    if (!store.routes[route])
        store.routes[route] = {};
    store.routes[route][selector] = rec;
    saveDomain(store);
}
//# sourceMappingURL=store.js.map