/**
 * Playbook file validation — read, hash, parse meta, static-analyze.
 *
 * All three gates must pass for `valid: true`:
 *   1. `parseMeta` — the meta literal is present, pure, and well-shaped
 *   2. `analyzeWithRules(source, nodeRules)` — no blocked Node constructs
 *   3. the declared-vs-used permission check — a file that calls
 *      `supersurf.evaluate` must declare `permissions: ['eval']`
 *
 * A record is returned for every outcome. `file`, `name`, `hash` and
 * `signature` are always populated so a caller can list a broken playbook
 * alongside the reason it is broken.
 *
 * @module security/validate
 */
import { type PlaybookMeta } from './meta';
/** The outcome of validating one playbook file. */
export interface ValidationRecord {
    file: string;
    name: string;
    hash: string;
    valid: boolean;
    error?: string;
    meta?: PlaybookMeta;
    signature: string;
    validatedAt: number;
}
/** Strip the `.playbook.js` suffix from a path to get the playbook's name. */
export declare function playbookName(filePath: string): string;
/** Render the one-line call signature: `post_tweet(text, pin?)`. */
export declare function buildSignature(name: string, meta?: PlaybookMeta): string;
/** Read, hash, parse and statically analyze one playbook file. Never throws. */
export declare function validateFile(filePath: string): Promise<ValidationRecord>;
//# sourceMappingURL=validate.d.ts.map