import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// `npm test` runs smoke tests against built output, so it must build first,
// and `test.cli` must type-check cli (vitest alone does not).
const { scripts } = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8'));

describe('root test chain', () => {
  it('builds before npm test via pretest', () => {
    expect(scripts.pretest).toContain('npm run build');
  });

  it('type-checks cli in test.cli', () => {
    expect(scripts['test.cli']).toContain('typecheck');
  });
});
