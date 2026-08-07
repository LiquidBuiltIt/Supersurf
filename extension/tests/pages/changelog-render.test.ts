import { describe, it, expect } from 'vitest';
import { compareVersions, sliceSections, renderBulletHtml, type ChangelogSection } from '../../src/pages/changelog-render';

describe('compareVersions', () => {
  it('compares numerically, not lexicographically', () => {
    expect(compareVersions('3.10.0', '3.9.0')).toBeGreaterThan(0);
    expect(compareVersions('3.9.0', '3.10.0')).toBeLessThan(0);
  });

  it('returns 0 for equal versions', () => {
    expect(compareVersions('3.3.0', '3.3.0')).toBe(0);
  });

  it('compares major over minor over patch', () => {
    expect(compareVersions('4.0.0', '3.9.9')).toBeGreaterThan(0);
    expect(compareVersions('3.1.0', '3.0.9')).toBeGreaterThan(0);
    expect(compareVersions('3.0.2', '3.0.1')).toBeGreaterThan(0);
  });

  it('treats unparsable input as lower than any parsable version', () => {
    expect(compareVersions('garbage', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', 'garbage')).toBeGreaterThan(0);
  });
});

describe('sliceSections', () => {
  const sections: ChangelogSection[] = [
    { version: '3.3.0', date: '2026-08-05', bullets: ['c'] },
    { version: '3.2.0', date: '2026-07-03', bullets: ['b'] },
    { version: '3.10.0', date: '2026-09-01', bullets: ['z'] }, // out of natural file order on purpose
    { version: '2.0.0', date: '2026-05-13', bullets: ['a'] },
  ];

  it('includes versions strictly greater than from, up to and including curr', () => {
    const result = sliceSections(sections, '3.2.0', '3.3.0');
    expect(result.map((s) => s.version)).toEqual(['3.3.0']);
  });

  it('excludes the from version itself', () => {
    const result = sliceSections(sections, '3.3.0', '3.3.0');
    expect(result).toEqual([]);
  });

  it('sorts results newest first using numeric comparison (3.10.0 > 3.9.0 case)', () => {
    const result = sliceSections(sections, '2.0.0', '3.10.0');
    expect(result.map((s) => s.version)).toEqual(['3.10.0', '3.3.0', '3.2.0']);
  });

  it('treats from === null as "everything up to curr"', () => {
    const result = sliceSections(sections, null, '3.3.0');
    expect(result.map((s) => s.version)).toEqual(['3.3.0', '3.2.0', '2.0.0']);
  });

  it('returns empty when curr is older than every section', () => {
    const result = sliceSections(sections, null, '1.0.0');
    expect(result).toEqual([]);
  });
});

describe('renderBulletHtml', () => {
  it('renders **bold** as <strong>', () => {
    expect(renderBulletHtml('**feat**: something new')).toBe('<strong>feat</strong>: something new');
  });

  it('renders `code` as <code>', () => {
    expect(renderBulletHtml('run `npm test`')).toBe('run <code>npm test</code>');
  });

  it('escapes HTML-significant characters', () => {
    expect(renderBulletHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });

  it('handles both bold and code in the same bullet', () => {
    expect(renderBulletHtml('**fix**: `foo` now works')).toBe('<strong>fix</strong>: <code>foo</code> now works');
  });

  it('leaves plain text untouched', () => {
    expect(renderBulletHtml('just a plain bullet')).toBe('just a plain bullet');
  });
});
