/**
 * Is the SuperSurf Claude Code plugin installed? Read once at startup so tips
 * can point at a skill, or at the plugin install command when there is none.
 *
 * @module plugin-detect
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/**
 * True when `~/.claude/plugins/installed_plugins.json` lists a `supersurf@…`
 * install whose directory still holds the base skill. Never throws: a missing
 * or malformed file only means tips show the install-the-plugin line.
 */
// ponytail: Claude Code only — other harnesses need their own lookup when they get a manifest.
export function detectPluginSkills(home: string = homedir()): boolean {
  try {
    const file = join(home, '.claude', 'plugins', 'installed_plugins.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    for (const [key, installs] of Object.entries<unknown>(data?.plugins ?? {})) {
      if (!key.startsWith('supersurf@') || !Array.isArray(installs)) continue;
      for (const i of installs) {
        const p = (i as { installPath?: unknown })?.installPath;
        if (typeof p === 'string' && existsSync(join(p, 'skills', 'supersurf', 'SKILL.md'))) return true;
      }
    }
  } catch {
    // unreadable or malformed — treat as not installed
  }
  return false;
}
