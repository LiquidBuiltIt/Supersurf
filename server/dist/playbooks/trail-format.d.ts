/**
 * Rendering for the in-memory action trail.
 *
 * Split out of the old `playbooks/format.ts` when the JSON playbook format was
 * deleted. `formatHistory` is the only part of that module that survived, because
 * `playbooks {action:"history"}` reads the trail singleton, never the disk — it is
 * how a script author reads back the selectors a working run actually used.
 *
 * @module playbooks/trail-format
 */
import type { TrailEntry } from './types';
export declare function formatHistory(entries: TrailEntry[], total: number, offset: number): string;
//# sourceMappingURL=trail-format.d.ts.map