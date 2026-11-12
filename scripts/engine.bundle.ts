#!/usr/bin/env npx tsx
/**
 * Bundle engine/ into daemon/dist/engine for npm publish (P1: one engine copy,
 * shipped inside supersurf-daemon). Run it BEFORE shared.bundle.ts so that script
 * rewrites the engine's require("shared") to the daemon's bundled copy.
 *
 * Usage: npx tsx scripts/engine.bundle.ts
 */
import path from 'path';
import { bundleEngine } from './engine-bundle-lib';

try {
  const n = bundleEngine(path.resolve(__dirname, '..'));
  console.log(`  Copied ${n} file(s) → daemon/dist/engine/`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
