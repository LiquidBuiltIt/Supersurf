"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeHost = normalizeHost;
exports.normalizeDomain = normalizeDomain;
exports.buildPlaybookDomainIndex = buildPlaybookDomainIndex;
exports.matchPlaybookNamesForUrl = matchPlaybookNamesForUrl;
exports.formatPlaybookHintLine = formatPlaybookHintLine;
exports.formatInvalidPlaybookWarning = formatInvalidPlaybookWarning;
const registry_1 = require("./registry");
const MAX_NAMES = 5;
function stripWww(host) {
    const lower = host.toLowerCase();
    return lower.startsWith('www.') ? lower.slice(4) : lower;
}
/**
 * Extract and normalize the hostname from a URL. Returns `null` for a
 * missing/malformed URL or a non-http(s) scheme (e.g. `chrome://`, `about:`,
 * `file://`) — those never contribute a matchable domain.
 */
function normalizeHost(rawUrl) {
    if (!rawUrl)
        return null;
    try {
        const u = new URL(rawUrl);
        if (u.protocol !== 'http:' && u.protocol !== 'https:')
            return null;
        const host = stripWww(u.hostname);
        return host || null;
    }
    catch {
        return null;
    }
}
/**
 * Normalize a bare domain string (not a full URL) the same way, for the
 * `playbooks {action:"list", domain:"..."}` filter param.
 */
function normalizeDomain(raw) {
    return stripWww(raw.trim());
}
/**
 * Index every VALID script by its declared starting point.
 *
 * `startingPoint` is author-written prose, so it arrives either as a bare
 * domain (`x.com`) or as a full URL (`https://www.github.com/issues`).
 * `normalizeHost` handles the URL form and returns null for the bare form
 * (no scheme, so `new URL` throws); `normalizeDomain` handles the bare form.
 * Trying them in that order covers both without either function changing.
 */
function buildPlaybookDomainIndex() {
    const index = new Map();
    for (const rec of (0, registry_1.getRecords)()) {
        // A script that does not validate cannot run, so suggesting it would be a
        // lie. It is reported separately by `formatInvalidPlaybookWarning`.
        if (!rec.valid)
            continue;
        const raw = rec.meta?.startingPoint;
        if (typeof raw !== 'string' || !raw.trim())
            continue;
        const domain = normalizeHost(raw) ?? normalizeDomain(raw);
        if (!domain)
            continue;
        const names = index.get(domain);
        if (names)
            names.push(rec.name);
        else
            index.set(domain, [rec.name]);
    }
    for (const names of index.values())
        names.sort((a, b) => a.localeCompare(b));
    return index;
}
/**
 * Look up the playbook names matching a tab URL's normalized host.
 * Returns `null` when the URL has no matchable host or there is no match —
 * callers should not render a hint in either case.
 */
function matchPlaybookNamesForUrl(index, url) {
    const host = normalizeHost(url);
    if (!host)
        return null;
    // A map entry is only ever created together with its first name — never
    // empty — so no `names.length > 0` guard is needed here.
    return index.get(host) ?? null;
}
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
function formatPlaybookHintLine(names) {
    if (names.length <= MAX_NAMES) {
        return `► ${names.length} playbooks available: ${names.join(', ')} | playbooks "list" for more details`;
    }
    const shown = names.slice(0, MAX_NAMES);
    return `► 5+ playbooks available: ${shown.join(', ')} + more | playbooks "list" for more details`;
}
/**
 * One line naming every script that failed validation. Harness principle:
 * report the truth. A silently skipped script is indistinguishable from one
 * the author never wrote.
 */
function formatInvalidPlaybookWarning(records) {
    if (records.length === 0)
        return null;
    const parts = records.map(r => `${r.name}: ${r.error ?? 'unknown validation error'}`);
    return `⚠️ ${records.length} playbook${records.length === 1 ? '' : 's'} failed validation — ${parts.join(' | ')}`;
}
//# sourceMappingURL=hint.js.map