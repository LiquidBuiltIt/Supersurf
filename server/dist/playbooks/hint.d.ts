/**
 * Status-header discovery hint — surfaces playbook scripts whose declared
 * starting point matches the currently attached tab's domain, plus a warning
 * for scripts that fail validation.
 *
 * The old derivation walked each recorded step's `url`. A `.playbook.js` file
 * has no recorded URLs, so `meta.startingPoint` replaces it — which is why the
 * spec made `startingPoint` part of the meta block at all.
 *
 * `normalizeHost`/`normalizeDomain` moved here verbatim from the deleted
 * `playbooks/domains.ts`; they are consumed by `backend.ts` and by this module,
 * and outlived the derivation they used to serve. Verbatim is load-bearing:
 * `normalizeHost` rejects non-http(s) schemes so `chrome://`, `about:` and
 * `file://` tabs never match a playbook, and `normalizeDomain` does NOT parse
 * URLs — it normalizes a bare domain for the `list` filter.
 *
 * Pure helpers. The mutable cache and once-per-session suppression live on
 * `ConnectionManager` (see `backend.ts`).
 *
 * @module playbooks/hint
 */
import type { ValidationRecord } from '../security/validate';
/** domain -> sorted, deduped playbook names that match it. */
export type PlaybookDomainIndex = Map<string, string[]>;
/**
 * Extract and normalize the hostname from a URL. Returns `null` for a
 * missing/malformed URL or a non-http(s) scheme (e.g. `chrome://`, `about:`,
 * `file://`) — those never contribute a matchable domain.
 */
export declare function normalizeHost(rawUrl: string | undefined | null): string | null;
/**
 * Normalize a bare domain string (not a full URL) the same way, for the
 * `playbooks {action:"list", domain:"..."}` filter param.
 */
export declare function normalizeDomain(raw: string): string;
/**
 * Index every VALID script by its declared starting point.
 *
 * `startingPoint` is author-written prose, so it arrives either as a bare
 * domain (`x.com`) or as a full URL (`https://www.github.com/issues`).
 * `normalizeHost` handles the URL form and returns null for the bare form
 * (no scheme, so `new URL` throws); `normalizeDomain` handles the bare form.
 * Trying them in that order covers both without either function changing.
 */
export declare function buildPlaybookDomainIndex(): PlaybookDomainIndex;
/**
 * Look up the playbook names matching a tab URL's normalized host.
 * Returns `null` when the URL has no matchable host or there is no match —
 * callers should not render a hint in either case.
 */
export declare function matchPlaybookNamesForUrl(index: PlaybookDomainIndex, url: string | undefined | null): string[] | null;
/**
 * Render the exact status-header hint line for a set of matched playbook
 * names. Caps the visible list at 5 names; beyond that, the count becomes
 * the literal string `5+` and the line ends with `+ more`.
 *
 * Expects `names` already sorted — `buildPlaybookDomainIndex` sorts once at
 * build time, and every production caller reads through
 * `matchPlaybookNamesForUrl`, which returns that same sorted list. Re-sorting
 * here would be dead work on every status-header render.
 */
export declare function formatPlaybookHintLine(names: string[]): string;
/**
 * One line naming every script that failed validation. Harness principle:
 * report the truth. A silently skipped script is indistinguishable from one
 * the author never wrote.
 */
export declare function formatInvalidPlaybookWarning(records: ValidationRecord[]): string | null;
//# sourceMappingURL=hint.d.ts.map