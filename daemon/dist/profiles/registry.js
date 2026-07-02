"use strict";
/**
 * ProfileRegistry — CRUD for managed Chromium profiles.
 *
 * Each profile lives at ~/.supersurf/profiles/<name>/ with a supersurf.json
 * config file and a chrome-data/ directory for Chromium's --user-data-dir.
 *
 * @module profiles/registry
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProfileRegistry = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const debugLog = (...args) => {
    const logger = global.DAEMON_LOGGER;
    if (logger)
        logger.log('[Profiles]', ...args);
    else if (global.DAEMON_DEBUG)
        console.error('[Profiles]', ...args);
};
const RESERVED_NAMES = new Set(['false', 'true', 'null', '']);
const NAME_REGEX = /^[a-z0-9][a-z0-9-]{0,31}$/;
class ProfileRegistry {
    profilesDir;
    runningPids = new Map();
    runningOwners = new Map();
    constructor(profilesDir) {
        this.profilesDir = profilesDir;
        fs_1.default.mkdirSync(profilesDir, { recursive: true });
    }
    /** Validate a profile name. Throws on invalid names. */
    validateName(name) {
        if (!name || typeof name !== 'string') {
            throw new Error('Profile name is required');
        }
        if (RESERVED_NAMES.has(name)) {
            throw new Error(`Profile name "${name}" is reserved`);
        }
        if (!NAME_REGEX.test(name)) {
            throw new Error(`Invalid profile name "${name}". Must be lowercase alphanumeric + hyphens, ` +
                `max 32 chars, no leading hyphen.`);
        }
    }
    /** Get the directory path for a profile. */
    profileDir(name) {
        return path_1.default.join(this.profilesDir, name);
    }
    /** Get the config file path for a profile. */
    configPath(name) {
        return path_1.default.join(this.profileDir(name), 'supersurf.json');
    }
    /** Create a new profile. */
    create(name, experiments) {
        this.validateName(name);
        if (this.exists(name)) {
            throw new Error(`Profile '${name}' already exists`);
        }
        const config = {
            name,
            created: new Date().toISOString(),
            initialized: false,
        };
        if (experiments && Object.keys(experiments).length > 0) {
            config.experiments = experiments;
        }
        const dir = this.profileDir(name);
        fs_1.default.mkdirSync(path_1.default.join(dir, 'chrome-data'), { recursive: true });
        fs_1.default.writeFileSync(this.configPath(name), JSON.stringify(config, null, 2), 'utf8');
        debugLog(`Profile created: "${name}"`);
        return config;
    }
    /** List all profiles with their running state. */
    list() {
        if (!fs_1.default.existsSync(this.profilesDir))
            return [];
        const entries = fs_1.default.readdirSync(this.profilesDir, { withFileTypes: true });
        const result = [];
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            const config = this.get(entry.name);
            if (config) {
                result.push({
                    name: config.name,
                    created: config.created,
                    running: this.isRunning(entry.name),
                });
            }
        }
        return result;
    }
    /** Get a profile's config by name. Returns null if not found. */
    get(name) {
        const configFile = this.configPath(name);
        if (!fs_1.default.existsSync(configFile))
            return null;
        try {
            return JSON.parse(fs_1.default.readFileSync(configFile, 'utf8'));
        }
        catch {
            return null;
        }
    }
    /** Delete a profile. Throws if active sessions are connected. */
    delete(name, sessions) {
        if (!this.exists(name)) {
            throw new Error(`Profile '${name}' not found`);
        }
        const activeSessions = sessions.getSessionsForProfile(name);
        if (activeSessions.length > 0) {
            throw new Error(`Cannot delete profile '${name}' — active sessions are connected. ` +
                `Ask the user to disconnect those sessions first.`);
        }
        // Kill Chromium if running
        const pid = this.getRunningPid(name);
        if (pid !== null) {
            try {
                process.kill(pid, 'SIGTERM');
                debugLog(`Killed Chromium for profile "${name}" (pid ${pid})`);
            }
            catch { }
            this.clearRunningPid(name);
        }
        // Delete profile directory
        const dir = this.profileDir(name);
        fs_1.default.rmSync(dir, { recursive: true, force: true });
        debugLog(`Profile deleted: "${name}"`);
    }
    /** Check if a profile exists (directory + config file). */
    exists(name) {
        return fs_1.default.existsSync(this.configPath(name));
    }
    /** Mark a profile as initialized (registration complete). */
    markInitialized(name) {
        const config = this.get(name);
        if (!config)
            throw new Error(`Profile '${name}' not found`);
        config.initialized = true;
        fs_1.default.writeFileSync(this.configPath(name), JSON.stringify(config, null, 2), 'utf8');
        debugLog(`Profile "${name}" marked as initialized`);
    }
    /** Check if a profile has been initialized. */
    isInitialized(name) {
        const config = this.get(name);
        return config?.initialized ?? false;
    }
    // ─── Running PID tracking (in-memory) ─────────────────────
    setRunningPid(name, pid, owner = 'daemon') {
        this.runningPids.set(name, pid);
        this.runningOwners.set(name, owner);
    }
    clearRunningPid(name) {
        this.runningPids.delete(name);
        this.runningOwners.delete(name);
    }
    getRunningPid(name) {
        return this.runningPids.get(name) ?? null;
    }
    /** Who spawned the running Chromium for this profile, or null if not running. */
    getOwner(name) {
        return this.runningOwners.get(name) ?? null;
    }
    /** True if the running Chromium for this profile was launched by the user (CLI). */
    isUserOwned(name) {
        return this.runningOwners.get(name) === 'user';
    }
    /** True if any profile has a live user-owned Chromium. */
    hasUserOwnedRunning() {
        for (const [name, owner] of [...this.runningOwners.entries()]) {
            if (owner === 'user' && this.isRunning(name))
                return true;
        }
        return false;
    }
    isRunning(name) {
        const pid = this.runningPids.get(name);
        if (pid === undefined)
            return false;
        try {
            process.kill(pid, 0);
            return true;
        }
        catch {
            this.clearRunningPid(name);
            return false;
        }
    }
}
exports.ProfileRegistry = ProfileRegistry;
//# sourceMappingURL=registry.js.map