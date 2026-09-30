import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { detectPluginSkills } from '../src/plugin-detect';

let home: string;
const pluginsDir = () => join(home, '.claude', 'plugins');
const writeInstalled = (body: string) => {
  mkdirSync(pluginsDir(), { recursive: true });
  writeFileSync(join(pluginsDir(), 'installed_plugins.json'), body);
};
const makeInstall = () => {
  const p = join(home, 'install');
  mkdirSync(join(p, 'skills', 'supersurf'), { recursive: true });
  writeFileSync(join(p, 'skills', 'supersurf', 'SKILL.md'), '---\nname: supersurf\n---\n');
  return p;
};

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'ss-detect-')); });

describe('detectPluginSkills', () => {
  it('is true when a supersurf@ install has the base skill on disk', () => {
    writeInstalled(JSON.stringify({ version: 2, plugins: { 'supersurf@supersurf': [{ installPath: makeInstall() }] } }));
    expect(detectPluginSkills(home)).toBe(true);
  });
  it('is false when the file is missing', () => {
    expect(detectPluginSkills(home)).toBe(false);
  });
  it('is false when the file is malformed', () => {
    writeInstalled('{not json');
    expect(detectPluginSkills(home)).toBe(false);
  });
  it('is false when the installPath no longer exists', () => {
    writeInstalled(JSON.stringify({ plugins: { 'supersurf@supersurf': [{ installPath: join(home, 'gone') }] } }));
    expect(detectPluginSkills(home)).toBe(false);
  });
  it('ignores other plugins that happen to contain a supersurf skill dir', () => {
    writeInstalled(JSON.stringify({ plugins: { 'other@x': [{ installPath: makeInstall() }] } }));
    expect(detectPluginSkills(home)).toBe(false);
  });
});
