/**
 * The single, deliberate build-time source import from `server/src/`.
 *
 * Item 27 compiles `playbook ls|inspect|validate|migrate` INTO this binary, and
 * those four live under server/src/playbooks + server/src/security. Bun bundles
 * TypeScript from disk, so this is a source-level build dependency, not an npm
 * one: no `dependencies` entry, no node_modules lookup, no runtime coupling.
 *
 * The alternative — hoisting playbooks/* and security/* into shared/ — would
 * force shared to declare acorn + acorn-walk as runtime dependencies and break
 * its zero-runtime-dependency rule. Concentrating the coupling here is cheaper.
 *
 * VERIFIED: this closure reaches node builtins, acorn and acorn-walk only. It
 * contains NO native addon. `sharp` enters only through
 * server/src/tools/screenshot.ts, which nothing here imports.
 *
 * Do not add `../../server/src/...` paths anywhere else in cli/.
 *
 * @module server-imports
 */
export { doList, doInspect, doValidate } from '../../server/src/playbooks/report';
export { getPlaybooksDir, normalizeName } from '../../server/src/playbooks/paths';
export { refreshRegistry, getRecord } from '../../server/src/playbooks/registry';
export { runMigrate } from '../../server/src/playbooks/migrate';
export type { PlaybookMeta } from '../../server/src/security/meta';
