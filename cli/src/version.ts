/**
 * The binary's own version, injected by `bun build --define` at compile time.
 *
 * It is NOT read from package.json: a compiled binary has no package.json on
 * disk to read. This value is also the npx pin — a v3.6.0 binary always shells
 * out to `npx supersurf-mcp@3.6.0`, never `@latest`, so a CLI can never launch a
 * server speaking a protocol it does not know.
 *
 * The `typeof` guard keeps `vitest` and `tsc --noEmit` working, where the define
 * is absent.
 *
 * @module version
 */
declare const __SUPERSURF_VERSION__: string | undefined;

export const VERSION: string =
  typeof __SUPERSURF_VERSION__ === 'string' ? __SUPERSURF_VERSION__ : '0.0.0-dev';
