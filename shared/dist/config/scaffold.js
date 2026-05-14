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
exports.ensureConfigFile = ensureConfigFile;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const defaults_1 = require("./defaults");
function ensureConfigFile(filePath) {
    if (fs.existsSync(filePath)) {
        return { created: false, path: filePath };
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    try {
        fs.writeFileSync(filePath, JSON.stringify(defaults_1.SCAFFOLD_DEFAULTS, null, 2) + '\n', { encoding: 'utf-8', flag: 'wx' });
        return { created: true, path: filePath };
    }
    catch (err) {
        if (err?.code === 'EEXIST') {
            // Lost the race to another writer (e.g., concurrent daemon spawn). Idempotent.
            return { created: false, path: filePath };
        }
        throw err;
    }
}
//# sourceMappingURL=scaffold.js.map