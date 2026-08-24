/**
 * Playbook persistence — ONE FILE PER PLAYBOOK.
 *
 * Deliberately not a single index file. This repo has no file locking anywhere
 * and `writeFileSync` is last-write-wins, so a shared index would silently drop
 * a write whenever the CLI and the MCP server touched it at once — which is the
 * expected flow, since removal is CLI-only while creation is agent-driven.
 * Separate files mean `rm` and `create` never contend unless they name the same
 * playbook, and that case is already an explicit collision error.
 *
 * No memo cache here, unlike `experimental/fingerprinting/store.ts`: playbook
 * reads happen once per `run`, not per DOM node, so a cache would add a
 * staleness class for no measurable gain.
 *
 * @module playbooks/store
 */
import type { Playbook } from './types';
/** Test-only override of the storage directory. */
export declare function setBaseDirForTests(dir: string): void;
export declare function getBaseDir(): string;
/**
 * Normalize a name to snake_case. Never rejects on shape — the repo rule is
 * normalize, don't fault. Path separators are stripped, so a name can never
 * address a file outside the playbook directory.
 */
export declare function normalizeName(raw: string): string;
export declare function playbookExists(name: string): boolean;
export declare function loadPlaybook(name: string): Playbook | null;
/**
 * Write a playbook. Mode 0600 because steps carry the exact params used to
 * re-issue an action, which for a `type` step includes whatever text was typed.
 */
export declare function savePlaybook(pb: Playbook): void;
export declare function removePlaybook(name: string): boolean;
/** Every readable playbook. Corrupt files are skipped, not fatal. */
export declare function listPlaybooks(): Playbook[];
//# sourceMappingURL=store.d.ts.map