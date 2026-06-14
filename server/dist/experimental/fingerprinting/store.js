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
/** Test-only override of the storage directory. */
function setBaseDirForTests(dir) {
    baseDir = dir;
}
function domainFile(domain) {
    // domain is a hostname; safe as a filename. Strip anything odd defensively.
    const safe = domain.replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(baseDir, `${safe}.json`);
}
function loadDomain(domain) {
    try {
        return JSON.parse(fs.readFileSync(domainFile(domain), 'utf8'));
    }
    catch {
        return { domain, routes: {} };
    }
}
function saveDomain(store) {
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(domainFile(store.domain), JSON.stringify(store, null, 2));
}
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