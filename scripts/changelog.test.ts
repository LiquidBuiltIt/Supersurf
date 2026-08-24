import { describe, it, expect } from 'vitest';
import { parseSections, sectionsToJson, bulletType, typeBreakdown } from './changelog-json';

const SAMPLE = [
  '# Changelog',
  '',
  '## Unreleased',
  '',
  '- feat: something new **bold summary** here',
  '- fix: a bug',
  '',
  '## 1.1.0 — 2026-08-05',
  '',
  '- feat: bumped to 1.1.0',
  '  - nested detail (not a top-level bullet)',
  '',
  '## 1.0.0 — 2026-01-01',
  '',
  '- initial release with `code span`',
  '',
].join('\n');

describe('sectionsToJson', () => {
  it('emits the { sections: [...] } shape with Unreleased leading, newest-first', () => {
    const sections = parseSections(SAMPLE);
    const json = sectionsToJson(sections);

    expect(json.sections.map((s) => s.version)).toEqual(['Unreleased', '1.1.0', '1.0.0']);
  });

  it('sets date to null for Unreleased and the parsed em-dash date otherwise', () => {
    const json = sectionsToJson(parseSections(SAMPLE));

    expect(json.sections[0].date).toBeNull();
    expect(json.sections[1].date).toBe('2026-08-05');
    expect(json.sections[2].date).toBe('2026-01-01');
  });

  it('keeps bullets as raw top-level Markdown text, excluding nested bullets', () => {
    const json = sectionsToJson(parseSections(SAMPLE));

    expect(json.sections[0].bullets).toEqual([
      'feat: something new **bold summary** here',
      'fix: a bug',
    ]);
    expect(json.sections[1].bullets).toEqual(['feat: bumped to 1.1.0']);
    expect(json.sections[2].bullets).toEqual(['initial release with `code span`']);
  });

  it('round-trips through JSON.stringify/parse with the documented shape', () => {
    const json = sectionsToJson(parseSections(SAMPLE));
    const roundTripped = JSON.parse(JSON.stringify(json));

    expect(roundTripped).toEqual({
      sections: [
        {
          version: 'Unreleased',
          date: null,
          bullets: ['feat: something new **bold summary** here', 'fix: a bug'],
          itemCount: 2,
          typeCounts: [
            { type: 'feat', count: 1 },
            { type: 'fix', count: 1 },
          ],
        },
        {
          version: '1.1.0',
          date: '2026-08-05',
          bullets: ['feat: bumped to 1.1.0'],
          itemCount: 1,
          typeCounts: [{ type: 'feat', count: 1 }],
        },
        {
          version: '1.0.0',
          date: '2026-01-01',
          bullets: ['initial release with `code span`'],
          itemCount: 1,
          typeCounts: [{ type: 'other', count: 1 }],
        },
      ],
    });
  });

  it('handles a changelog with no Unreleased bullets/section gracefully', () => {
    const noUnreleased = [
      '# Changelog',
      '',
      '## 2.0.0 — 2026-02-02',
      '',
      '- only release',
      '',
    ].join('\n');

    const json = sectionsToJson(parseSections(noUnreleased));
    expect(json.sections).toEqual([
      {
        version: '2.0.0',
        date: '2026-02-02',
        bullets: ['only release'],
        itemCount: 1,
        typeCounts: [{ type: 'other', count: 1 }],
      },
    ]);
  });

  it('adds itemCount and typeCounts as purely additive fields', () => {
    const json = sectionsToJson(parseSections(SAMPLE));
    expect(json.sections[0].itemCount).toBe(2);
    expect(json.sections[0].typeCounts).toEqual([
      { type: 'feat', count: 1 },
      { type: 'fix', count: 1 },
    ]);
  });
});

describe('bulletType', () => {
  it('recognizes plain prefixes', () => {
    expect(bulletType('feat: something new')).toBe('feat');
    expect(bulletType('fix: a bug')).toBe('fix');
    expect(bulletType('chore: bump deps')).toBe('chore');
    expect(bulletType('docs: update README')).toBe('docs');
  });

  it('recognizes scoped prefixes', () => {
    expect(bulletType('feat(extension): add badge')).toBe('feat');
    expect(bulletType('fix(fingerprinting): tune threshold')).toBe('fix');
  });

  it('recognizes bold-wrapped prefixes, scoped or not', () => {
    expect(bulletType('**feat: description**')).toBe('feat');
    expect(bulletType('**feat(extension): description**')).toBe('feat');
    expect(bulletType('*fix: single-star bold*')).toBe('fix');
  });

  it('is case-insensitive on the type word', () => {
    expect(bulletType('Fix: capitalized')).toBe('fix');
    expect(bulletType('CHORE: shouting')).toBe('chore');
  });

  it('buckets any leading word: or word(scope): prefix under its own name', () => {
    expect(bulletType('security: patch a CVE')).toBe('security');
    expect(bulletType('perf(fingerprinting): tune threshold')).toBe('perf');
    expect(bulletType('BREAKING: removed a flag')).toBe('breaking');
  });

  it('buckets a bullet with no leading-token prefix at all as other', () => {
    expect(bulletType('no prefix at all, just prose')).toBe('other');
  });
});

describe('typeBreakdown', () => {
  it('counts bullets by type, sorted by count descending', () => {
    const bullets = ['feat: a', 'feat: b', 'fix: c', 'chore: d'];
    expect(typeBreakdown(bullets)).toEqual([
      { type: 'feat', count: 2 },
      { type: 'chore', count: 1 },
      { type: 'fix', count: 1 },
    ]);
  });

  it('breaks ties alphabetically', () => {
    const bullets = ['docs: a', 'chore: b', 'fix: c', 'feat: d'];
    expect(typeBreakdown(bullets)).toEqual([
      { type: 'chore', count: 1 },
      { type: 'docs', count: 1 },
      { type: 'feat', count: 1 },
      { type: 'fix', count: 1 },
    ]);
  });

  it('returns an empty array for no bullets', () => {
    expect(typeBreakdown([])).toEqual([]);
  });

  it('buckets security and perf(...) under their own names, not other', () => {
    const bullets = ['security: a', 'security: b', 'perf(fingerprinting): c', 'plain prose'];
    expect(typeBreakdown(bullets)).toEqual([
      { type: 'security', count: 2 },
      { type: 'other', count: 1 },
      { type: 'perf', count: 1 },
    ]);
  });
});
