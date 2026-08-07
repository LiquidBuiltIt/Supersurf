import { describe, it, expect } from 'vitest';
import { parseSections, sectionsToJson } from './changelog-json';

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
        { version: 'Unreleased', date: null, bullets: ['feat: something new **bold summary** here', 'fix: a bug'] },
        { version: '1.1.0', date: '2026-08-05', bullets: ['feat: bumped to 1.1.0'] },
        { version: '1.0.0', date: '2026-01-01', bullets: ['initial release with `code span`'] },
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
    expect(json.sections).toEqual([{ version: '2.0.0', date: '2026-02-02', bullets: ['only release'] }]);
  });
});
