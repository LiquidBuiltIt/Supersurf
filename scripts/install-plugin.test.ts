// scripts/install-plugin.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { execFileSync } from 'child_process';

const script = resolve(__dirname, '..', 'docs/install.sh');
const text = readFileSync(script, 'utf8');

describe('install.sh plugin step', () => {
  it('adds the marketplace and installs the plugin', () => {
    expect(text).toContain('claude plugin marketplace add LiquidBuiltIt/Supersurf');
    expect(text).toContain('claude plugin install supersurf@supersurf');
  });
  it('never dies in the plugin step', () => {
    const fn = /install_claude_plugin\(\) \{[\s\S]*?\n\}/.exec(text)?.[0] ?? '';
    expect(fn).not.toBe('');
    expect(fn).not.toMatch(/\bdie\b/);
  });
  it('guards on plugin support and keeps claude off stdin', () => {
    const fn = /install_claude_plugin\(\) \{[\s\S]*?\n\}/.exec(text)?.[0] ?? '';
    expect(fn).toMatch(/claude --help <\/dev\/null[^\n]*grep -qE/);
    expect(fn).not.toContain('claude plugin --help');
    const calls = fn.split('\n').filter((l) => /claude plugin (marketplace|install)/.test(l));
    expect(calls).toHaveLength(2);
    for (const l of calls) expect(l).toContain('</dev/null');
  });
  it('is valid sh', () => {
    execFileSync('sh', ['-n', script]);
  });
});
