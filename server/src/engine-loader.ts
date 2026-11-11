/**
 * Load the engine from `supersurf-daemon` (P1: one engine copy, shipped in the
 * daemon package, reached through this package's exact `supersurf-daemon` pin).
 * `import type` below is erased at build; no engine code is in this package.
 *
 * @module engine-loader
 */
import type * as EngineNs from 'engine';

export type EngineModule = typeof EngineNs;

const ENTRY = 'supersurf-daemon/dist/engine/index.js';

export function loadEngine(resolve: (id: string) => string = require.resolve): EngineModule {
  let entry: string;
  try {
    entry = resolve(ENTRY);
  } catch (e) {
    throw new Error(
      `supersurf-mcp could not find its engine in supersurf-daemon (${(e as Error).message}). ` +
        'Reinstall with: npx supersurf-mcp@latest',
    );
  }
  return require(entry) as EngineModule;
}
