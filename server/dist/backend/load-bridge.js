"use strict";
/**
 * Lazy loader for the BrowserBridge class. Loaded on first use, not at import time, for two reasons:
 *
 * 1. A static `import '../tools'` puts `tools.ts → tools/lib/dispatcher.ts:17 → tools/playbooks.ts:23 →
 *    playbooks/runner.ts:19 → backend.ts` into `backend`'s static closure: a cycle.
 * 2. `tools/screenshot.ts:22` imports `sharp` (native) statically, so a static import loads it at MCP boot.
 *
 * @module backend/load-bridge
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
exports.loadBrowserBridge = loadBrowserBridge;
let BrowserBridge = null;
async function loadBrowserBridge() {
    if (!BrowserBridge) {
        const mod = await Promise.resolve().then(() => __importStar(require('../tools')));
        BrowserBridge = mod.BrowserBridge;
    }
    return BrowserBridge;
}
//# sourceMappingURL=load-bridge.js.map