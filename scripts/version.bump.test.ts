import { describe, it, expect } from 'vitest';
import { cutUnreleased } from './changelog-cut';

describe('cutUnreleased', () => {
  it('moves Unreleased bullets into a new version section, leaving Unreleased empty', () => {
    const content = [
      '# Changelog',
      '',
      '## Unreleased',
      '',
      '- feat: something new',
      '- fix: something fixed',
      '',
      '## 1.0.0 — 2026-01-01',
      '',
      '- initial release',
      '',
    ].join('\n');

    const result = cutUnreleased(content, '1.1.0', '2026-08-05');

    expect('warning' in result).toBe(false);
    if ('warning' in result) return; // narrow for TS
    expect(result.moved).toBe(2);

    const lines = result.content.split('\n');
    // fresh empty Unreleased: header immediately followed by one blank line
    // then the new version header — no bullets left behind.
    expect(lines).toEqual([
      '# Changelog',
      '',
      '## Unreleased',
      '',
      '## 1.1.0 — 2026-08-05', // em dash, not a hyphen
      '',
      '- feat: something new',
      '- fix: something fixed',
      '',
      '## 1.0.0 — 2026-01-01',
      '',
      '- initial release',
      '',
    ]);
  });

  it('inserts the blurb as an italic paragraph under the heading, above the bullets', () => {
    const content = [
      '# Changelog',
      '',
      '## Unreleased',
      '',
      '- feat: something new',
      '',
      '## 1.0.0 — 2026-01-01',
      '',
      '- initial release',
      '',
    ].join('\n');

    const result = cutUnreleased(content, '1.1.0', '2026-08-05', 'Playbooks can now run on their own.');

    expect('warning' in result).toBe(false);
    if ('warning' in result) return;

    const lines = result.content.split('\n');
    expect(lines).toEqual([
      '# Changelog',
      '',
      '## Unreleased',
      '',
      '## 1.1.0 — 2026-08-05',
      '',
      '*Playbooks can now run on their own.*',
      '',
      '- feat: something new',
      '',
      '## 1.0.0 — 2026-01-01',
      '',
      '- initial release',
      '',
    ]);
    // the blurb is a paragraph, not an item — moved counts bullets only
    expect(result.moved).toBe(1);
  });

  it('omits the blurb paragraph entirely when blurb is absent, empty, or whitespace-only', () => {
    const content = [
      '# Changelog',
      '',
      '## Unreleased',
      '',
      '- feat: something new',
      '',
    ].join('\n');

    for (const blurb of [undefined, '', '   ']) {
      const result = cutUnreleased(content, '1.1.0', '2026-08-05', blurb);
      expect('warning' in result).toBe(false);
      if ('warning' in result) continue;
      expect(result.content).not.toContain('*');
    }
  });

  it('warns and leaves content untouched when Unreleased has no bullets', () => {
    const content = [
      '# Changelog',
      '',
      '## Unreleased',
      '',
      '## 3.3.0 — 2026-08-05',
      '',
      '- some prior release note',
      '',
    ].join('\n');

    const result = cutUnreleased(content, '3.4.0', '2026-08-05');

    expect('warning' in result).toBe(true);
    if (!('warning' in result)) return;
    expect(result.warning).toMatch(/empty/i);
  });

  it('warns when the Unreleased header is missing entirely', () => {
    const content = [
      '# Changelog',
      '',
      '## 1.0.0 — 2026-01-01',
      '',
      '- initial release',
      '',
    ].join('\n');

    const result = cutUnreleased(content, '1.1.0', '2026-08-05');

    expect('warning' in result).toBe(true);
    if (!('warning' in result)) return;
    expect(result.warning).toMatch(/no.*unreleased/i);
  });

  it('throws when a section for the new version already exists', () => {
    const content = [
      '# Changelog',
      '',
      '## Unreleased',
      '',
      '- feat: something new',
      '',
      '## 1.1.0 — 2026-07-01',
      '',
      '- already shipped',
      '',
    ].join('\n');

    expect(() => cutUnreleased(content, '1.1.0', '2026-08-05')).toThrow(/already has a "## 1\.1\.0" section/);
  });
});
