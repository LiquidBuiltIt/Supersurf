/**
 * Parity lock for the two independent copies of `parseParamFlags`:
 * cli/src/playbook-cli.ts and server/src/playbooks/run-cli.ts. They matched
 * byte-for-byte at review time; nothing enforces that they still match after
 * the next edit to either one.
 *
 * This test lives in cli/tests/, NOT a shared module, on purpose. cli/ must
 * never import server/src/** at runtime (BACKLOG #28, ruling K3 — see the
 * SCOPE note and coupling lock in server-coupling.test.ts): the compiled
 * binary shells out to the npm package instead of loading its code in
 * process. But cli/tests/** is deliberately exempt from that ban — the
 * exemption exists precisely so a test can reach into server/ to assert
 * something about it, the same reason playbook-cli.test.ts already imports
 * test seams straight from server/src. Do NOT "fix" this duplication by
 * creating a runtime import between the two modules: that reopens the exact
 * coupling the K3 lock exists to keep closed.
 */
import { describe, it, expect } from 'vitest';
import { parseParamFlags as cliParseParamFlags } from '../src/playbook-cli';
import { parseParamFlags as serverParseParamFlags } from '../../server/src/playbooks/run-cli';
import type { PlaybookMeta } from '../../server/src/security/meta';

const META: PlaybookMeta = {
  description: 'x',
  params: {
    s: { type: 'string' },
    n: { type: 'number' },
    b: { type: 'boolean' },
  },
};

const CASES: { name: string; pairs: string[]; meta: PlaybookMeta }[] = [
  { name: 'a valid string param', pairs: ['s=hi'], meta: META },
  { name: 'a valid number param', pairs: ['n=42'], meta: META },
  { name: 'a valid boolean param', pairs: ['b=true'], meta: META },
  { name: 'an unknown key (undeclared param stays a string)', pairs: ['zzz=1'], meta: META },
  { name: 'a malformed pair with no =', pairs: ['justakey'], meta: META },
  { name: 'a value that fails type coercion', pairs: ['n=abc'], meta: META },
  { name: 'the empty-pairs case', pairs: [], meta: META },
];

describe('parseParamFlags parity: cli/src/playbook-cli.ts vs server/src/playbooks/run-cli.ts', () => {
  for (const { name, pairs, meta } of CASES) {
    it(`produces identical output for ${name}, including the error string`, () => {
      const cliResult = cliParseParamFlags(pairs, meta);
      const serverResult = serverParseParamFlags(pairs, meta);
      expect(cliResult).toEqual(serverResult);
    });
  }
});
