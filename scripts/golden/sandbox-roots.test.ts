import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO } from './harness';

// The sandbox host as published: the engine bundle inside the daemon package.
const HOST_JS = 'daemon/dist/engine/security/sandbox/host.js';

const host = createRequire(import.meta.url)(path.join(REPO, HOST_JS)) as {
  resolveChildEntry(): { entry: string };
  permissionFlagsFor(nodeVersion: string, entry: string): string[];
};

describe('golden: sandbox read roots', () => {
  const { entry } = host.resolveChildEntry();

  it('the child entry is a compiled .js file that exists', () => {
    expect(entry.endsWith('.js')).toBe(true);
    expect(fs.existsSync(entry)).toBe(true);
  });

  it('read roots exist, cover the entry, and cover the hoisted acorn the child imports', () => {
    const flags = host.permissionFlagsFor('v22.0.0', entry);
    expect(flags[0]).toMatch(/^--(experimental-)?permission$/);
    const roots = flags.slice(1).map((f) => f.replace('--allow-fs-read=', ''));
    for (const r of roots) expect(fs.existsSync(r), r).toBe(true);
    expect(roots.some((r) => entry.startsWith(r + path.sep)), `entry ${entry} under ${roots}`).toBe(true);
    const acorn = createRequire(entry).resolve('acorn');
    expect(roots.some((r) => acorn.startsWith(r + path.sep)), `acorn ${acorn} under ${roots}`).toBe(true);
  });

  it('a .ts entry and an old Node get no permission flags', () => {
    expect(host.permissionFlagsFor('v22.0.0', '/x/child.ts')).toEqual([]);
    expect(host.permissionFlagsFor('v18.0.0', entry)).toEqual([]);
  });
});
