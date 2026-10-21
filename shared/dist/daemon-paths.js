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
exports.supersurfDir = supersurfDir;
exports.sockPath = sockPath;
exports.pidPath = pidPath;
exports.readDaemonPid = readDaemonPid;
exports.isProcessAlive = isProcessAlive;
exports.isDaemonRunning = isDaemonRunning;
/**
 * Daemon file locations and liveness check, shared by daemon, server and cli.
 *
 * Everything is a function, not a constant: paths come from `os.homedir()` at
 * call time so tests can point HOME at a temp dir after import.
 */
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
/** `~/.supersurf` */
function supersurfDir() {
    return path.join(os.homedir(), '.supersurf');
}
/** Daemon Unix socket: `~/.supersurf/daemon.sock` */
function sockPath() {
    return path.join(supersurfDir(), 'daemon.sock');
}
/** Daemon pidfile: `~/.supersurf/daemon.pid` */
function pidPath() {
    return path.join(supersurfDir(), 'daemon.pid');
}
/** PID from the pidfile, or null when it is missing, unreadable or not an integer. */
function readDaemonPid() {
    try {
        const pid = parseInt(fs.readFileSync(pidPath(), 'utf-8').trim(), 10);
        return Number.isNaN(pid) ? null : pid;
    }
    catch {
        return null;
    }
}
/** True when a process with this PID exists (signal 0 probe). */
function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
/** True when the pidfile names a live process. */
function isDaemonRunning() {
    const pid = readDaemonPid();
    return pid !== null && isProcessAlive(pid);
}
//# sourceMappingURL=daemon-paths.js.map