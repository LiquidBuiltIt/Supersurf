/**
 * Is the SuperSurf Claude Code plugin installed? Read once at startup so tips
 * can point at a skill, or at the plugin install command when there is none.
 *
 * @module plugin-detect
 */
/**
 * True when `~/.claude/plugins/installed_plugins.json` lists a `supersurf@…`
 * install whose directory still holds the base skill. Never throws: a missing
 * or malformed file only means tips show the install-the-plugin line.
 */
export declare function detectPluginSkills(home?: string): boolean;
//# sourceMappingURL=plugin-detect.d.ts.map