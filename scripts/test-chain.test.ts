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

const PKGS = ['shared', 'daemon', 'server', 'cli', 'extension'];

describe.each(PKGS)('%s test chain', (pkg) => {
  const read = (f: string) => JSON.parse(readFileSync(resolve(__dirname, '..', pkg, f), 'utf8'));

  it('npm test type-checks the tests before vitest', () => {
    expect(read('package.json').scripts.test).toBe('npm run typecheck.tests && vitest run');
  });

  it('tsconfig.test.json sets its own exclude without "tests"', () => {
    const { exclude } = read('tsconfig.test.json');
    expect(Array.isArray(exclude)).toBe(true);
    expect(exclude).not.toContain('tests');
  });
});
