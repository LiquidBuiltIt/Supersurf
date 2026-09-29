"use strict";
/**
 * Is the SuperSurf Claude Code plugin installed? Read once at startup so tips
 * can point at a skill, or at the plugin install command when there is none.
 *
 * @module plugin-detect
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectPluginSkills = detectPluginSkills;
const fs_1 = require("fs");
const os_1 = require("os");
const path_1 = require("path");
/**
 * True when `~/.claude/plugins/installed_plugins.json` lists a `supersurf@…`
 * install whose directory still holds the base skill. Never throws: a missing
 * or malformed file only means tips show the install-the-plugin line.
 */
// ponytail: Claude Code only — other harnesses need their own lookup when they get a manifest.
function detectPluginSkills(home = (0, os_1.homedir)()) {
    try {
        const file = (0, path_1.join)(home, '.claude', 'plugins', 'installed_plugins.json');
        const data = JSON.parse((0, fs_1.readFileSync)(file, 'utf8'));
        for (const [key, installs] of Object.entries(data?.plugins ?? {})) {
            if (!key.startsWith('supersurf@') || !Array.isArray(installs))
                continue;
            for (const i of installs) {
                const p = i?.installPath;
                if (typeof p === 'string' && (0, fs_1.existsSync)((0, path_1.join)(p, 'skills', 'supersurf', 'SKILL.md')))
                    return true;
            }
        }
    }
    catch {
        // unreadable or malformed — treat as not installed
    }
    return false;
}
//# sourceMappingURL=plugin-detect.js.map