#!/usr/bin/env bun
/**
 * Compile `cli/src/supersurf.ts` to four standalone binaries.
 *
 * Bun 1.3.14 cross-compiles every target from a single host (verified: a
 * linux-x64 host produced correct ELF aarch64 and Mach-O x86_64/arm64
 * artifacts), so this needs ONE machine, not a runner matrix. Bun downloads
 * each target's runtime on first use — cache ~/.bun or accept a cold fetch.
 *
 * Output goes to cli/build/, which is gitignored: each binary is ~95 MB and
 * this package publishes no JavaScript, so it has no tracked dist/.
 */
import { $ } from 'bun';
import pkg from './package.json';

const TARGETS = [
  'bun-linux-x64',
  'bun-linux-arm64',
  'bun-darwin-x64',
  'bun-darwin-arm64',
] as const;

// SUPERSURF_CLI_VERSION compiles a binary at a version the repo has not been
// bumped to yet. The version is not decoration: it is the npx pin, so
// `supersurf mcp` runs `supersurf-mcp@<this string>`. Overriding it produces a
// binary whose pin does not resolve until that version is published — fine for
// a draft release built ahead of the bump, wrong for anything a user can reach.
const version: string = process.env.SUPERSURF_CLI_VERSION || pkg.version;
const only = process.argv[2];

if (version !== pkg.version) {
  console.log(`  ! version overridden: ${pkg.version} -> ${version} (SUPERSURF_CLI_VERSION)`);
}

for (const target of TARGETS) {
  if (only && target !== only) continue;
  const suffix = target.replace(/^bun-/, '');
  const out = `./build/supersurf-${suffix}`;
  console.log(`  building ${target} -> ${out}`);
  await $`bun build ./src/supersurf.ts --compile --target=${target} --define __SUPERSURF_VERSION__=${JSON.stringify(version)} --outfile ${out}`;
}
console.log(`  Done — supersurf ${version}, ${only ? 1 : TARGETS.length} target(s) in cli/build/`);
