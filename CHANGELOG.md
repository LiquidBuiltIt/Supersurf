# Changelog

All notable changes to SuperSurf are documented in this file.

Format: `feat` = new capability, `fix` = bug fix, `security` = hardening, `chore` = maintenance.

## 2.0.0 — 2026-05-13

- **BREAKING: feat**: 3-layer ConfigService — CLI flag > env var > `~/.supersurf/config.json` > hardcoded defaults. Daemon auto-scaffolds `~/.supersurf/config.json` on first run with safe defaults. ConfigService lives in the `shared/` workspace so daemon and server consume one source of truth
- **BREAKING: feat**: `experimental_features` MCP tool removed. Experiments are now opted into via `~/.supersurf/config.json` and require a daemon restart. Rationale: audit-log data showed 4 of 5 historical callers used it once at startup; the remaining call sites became impossible after `secure_eval` graduated in v1.11.0
- **BREAKING: feat**: `AuditLogger` → `UsageMetricsLogger` rename. New session files are written as `metrics-{sessionId}-{ts}.ndjson` (was `audit-{sessionId}-{ts}.ndjson`). Older sessions remain at the old path; the usage-data-audit skill globs both prefixes
- **BREAKING: feat**: usage-metrics logging is now gated by `config.logging.usage_metrics`. Hardcoded default is `false`, scaffolded `~/.supersurf/config.json` default is `true` — operators who never touch config still get telemetry; operators with a config file opt in explicitly by leaving the default
- feat: `experiments.profiles` is now a first-class config key (equivalent to the legacy `SUPERSURF_EXPERIMENTS=profiles` env var, which still works as a fallback). Daemon-startup flag only — not session-toggleable. Profile tool descriptions and error messages now direct operators to edit `config.json` rather than set env vars
- feat: new env vars `SUPERSURF_CONFIG_FILE` (path override) and `SUPERSURF_DEBUG` (alias for `--debug`)
- chore: CLAUDE.md updated for v2 architecture
- chore: usage-data-audit skill updated to glob both `metrics-*.ndjson` and legacy `audit-*.ndjson`

## 1.11.0 — 2026-05-03

- fix: rewrote two confusing CDP error strings agents kept hitting after a page failed to load. `Target crashed` and `CDP timeout: Runtime.evaluate (50000ms)` now expand into self-explanatory messages with recovery steps — close the tab, reopen, do not retry heavy DOM queries on the dead page. Surfaced by an audit-log review where agents repeatedly retried `browser_evaluate` against a hung renderer for ~10 calls before giving up
- fix: `browser_navigate` (url + reload) now detects Chrome's error interstitial (`body.className === 'neterror'` or `chrome-error://` location) after the wait and returns a clear error instead of a silent success. Previously the response said the navigate succeeded — but the page never actually loaded, and the next heavy DOM query crashed the renderer
- security: `secure_eval` graduated from experiment to a default-on protection. Three-layer RCE defense (AST static analysis → extension Proxy membrane → page-context Proxy wrapper) now runs on every `browser_evaluate` call without per-session opt-in. Toggling via `experimental_features` returns an explicit error directing operators to the new opt-out. Disable via `--disable-secure-eval` CLI flag or `SUPERSURF_DISABLE_SECURE_EVAL=1` in the server env (not recommended)
- feat: sharpened `browser_evaluate` schema — explicit "NOT for" list redirecting agents to `browser_navigate`, `browser_storage`, `browser_fill_form`/`browser_interact`, `browser_network_requests`. `readOnlyHint` flipped to `true` and title now reads "Evaluate JS (read-only)"
- fix: `browser_fill_form` now walks child frames when a selector misses the top frame — same DFS isolated-world pattern v1.10.0 added to `browser_interact`. Closes the iframe-nested form-field gap (52% of active fill_form errors in the audit logs) on iCIMS, embedded form-builders, and payment widgets
- fix: digit-leading element IDs (e.g. Ashby's `#883a762f-8c9b-...` UUIDs) are now transparently rewritten to `[id="..."]` form before reaching `document.querySelector`. CSS forbids ID identifiers that start with a digit — page-internal querySelector throws `SyntaxError: not a valid selector` — but Ashby (and others) emit them anyway. Closes 36% of active fill_form errors

## 1.10.1 — 2026-05-01

- chore: internal refactor — split `tools.ts` into `tools/lib/` (shared primitives: cdp, frames, sandbox, element-resolver, result-formatter, dispatcher, types) and split `tools/interaction.ts` into per-action files. No behavior change

## 1.10.0 — 2026-04-22

- feat: `browser_interact` actions with a `selector` now auto-fall-back to child frames on top-frame miss — DFS-walks the frame tree via `Page.createIsolatedWorld` and resolves elements in iframe-local coords back to top-frame viewport coords. Eliminates "Element not found" failures on iframe-nested elements (iCIMS, embedded form-builders, payment widgets) without forcing agents to think about frames

## 1.9.3 — 2026-04-17

- feat: `browser_evaluate` requires a `purpose` parameter — a free-text field where the agent explains why evaluate is needed instead of a dedicated tool (`browser_lookup`, `browser_extract_content`, `browser_interact`, `browser_fill_form`, `browser_navigate`, `browser_get_element_styles`). Captured in the audit log for intent analysis. Missing/empty purpose is rejected before dispatch
- feat: contextual tip suppression — if a tip fires 3 consecutive times for the same (session, tool, tip_id), it is suppressed on subsequent calls until that tool is called without triggering it (per-tip reset). Stops high-volume repeat coaching (the `browser_lookup` tip fired 261 times in the recent job-search sessions with a 2% follow-through rate) from becoming wallpaper. Counters clear on `disconnect`

## 1.9.2 — 2026-04-10

- feat: profile tools (`profile_list`, `profile_create`, `profile_delete`) work without `connect`/`disconnect` — handlers spin up a temporary daemon connection when no active session exists, so agents can manage profiles from passive state
- chore: added `npm run tree` script for listing project source files
- chore: CLAUDE.md updated to reflect v1.9.1 state — added daemon experiments layer, tips system, dotenv, sandbox, chrome types, and missing test entries

## 1.9.1 — 2026-04-08

- chore: `scripts/publish.ts` now owns git tagging — `scripts/version.bump.ts` no longer creates tags. Tags only exist for versions actually shipped, so re-bumping or amending after a bump is free (no tag cleanup). Publish is idempotent on retry — existing tag at HEAD is reused, push failure on a freshly-created tag rolls it back for a clean retry

## 1.9.0 — 2026-04-08

- feat: `file_upload` walks child frames when the selector isn't found in the top frame — uses `Page.getFrameTree` + per-frame isolated worlds. Closes the iCIMS / Stripe / embedded form-builder gap where file inputs live inside iframes. Top-frame happy path is unchanged
- feat: tab recovery is now visible to agents — `BrowserBridge.formatResult()` extracts the `_recovery` envelope from extension responses and prefixes the response with `↻ tab recovered: stale tab N → M (url)` so agents know the tab changed mid-call
- fix: `fill_form` dispatches `new Event('input', ...)` instead of `new InputEvent('input', ...)` — `InputEvent` was routing some React versions down a composition-event path that bypassed the value tracker, leaving controlled-input state stale (e.g. Lever ATS `Resume_URL` silent failure). Per facebook/react#10135

## 1.8.0 — 2026-04-08

- feat: `browser_snapshot` coalesces adjacent `InlineTextBox` siblings into a single text node — cuts AX tree noise on text-heavy pages where Chrome splits long runs into per-line boxes
- feat: lightweight tab recovery — `ensureAttachedTab()` auto-recovers when the attached tab is null or stale (crashed/closed) instead of failing the call. Recovery prefers the active visible tab in the focused window. Surfaces `_recovery: { reason, previousTabId, newTabId, url }` on the result so agents know the tab changed
- feat: backend tool audit entries (`connect`/`disconnect`/`status`/`experimental_features`/`reload_mcp`/`profile_*`) now populate the `url` field — closes a session-boundary blind spot in audit analysis

## 1.7.0 — 2026-04-08

- fix: `browser_evaluate` function form now wraps as IIFE so arrow/async functions actually execute (previously returned `undefined`)
- fix: `fill_form` selector escaping — selectors with single quotes (e.g. ATS UUID-attribute selectors `[id='uuid-...']`) no longer break the inline JS template
- feat: `select_custom` fuzzy option matcher — 6-tier scoring (exact → alphanumeric → startsWith → substring) recovers from real-world ATS label mismatches like "United States" → "United States +1"
- feat: post-action validation for `fill_form`, `select_custom`, and `file_upload` — tools now read back DOM state after the mutation and prefix results with `✓` (verified) or `⚠` (mutation ran but read-back didn't confirm)
- docs: research note on the React value-tracker silent-failure mode for `fill_form` — DOM-level read-back is necessary but not sufficient to catch React state drift; fiber-walk verification deferred to a follow-up

## 1.6.5 — 2026-04-01

- feat: show tethered profile name in extension popup — makes identity theft between managed profiles immediately visible
- fix: version bump rollback now restores version files to previous version instead of leaving them bumped

## 1.6.4 — 2026-03-31

- chore: remove `browser_reload_extensions` — fatal for managed profiles

## 1.6.0 — 2026-03-28

- feat: targeted tool tips — 14 contextual hints appended to tool responses when agents use `browser_evaluate` for things purpose-built tools already handle (clicks, scrolls, value setting, DOM reads, position lookups, style inspection, innerHTML extraction)
- feat: `:has-text()` pseudo-selector documented in `browser_interact` schema description
- feat: `version` and `tip` fields in audit log entries for version correlation and tip effectiveness analysis
- fix: `select_custom` scopes option search to newly-opened dropdown via before/after diffing — fixes 87.5% error rate on pages with multiple custom dropdowns (e.g. Greenhouse job boards)

## 1.5.1 — 2026-03-28

- feat: daemon `stop` and `restart` commands
- feat: version stamp in audit log entries

## 1.5.0 — 2026-03-25

- feat: `select_custom` action for JS-driven dropdowns (non-native `<select>`)
- feat: enriched form field data in `browser_snapshot` and `browser_lookup`
- fix: `fill_form` dispatches focus/blur and uses `InputEvent` for React compat
- fix: auto-reattach to available tab when attached tab closes
- fix: evaluate wrapper handles statement code via nested IIFE
- fix: remove overly broad `data-state` check from `select_custom` detection

## 1.4.4 — 2026-03-19

- fix: popup window fix (dock nav homepage)
- chore: added publication scripts

## 1.4.3 — 2026-03-19

- feat: auto-update cached extension on daemon start if version is stale

## 1.4.2 — 2026-03-18

- fix: popup windows breaking tab operations — filter to normal windows only
- feat: expose `tabId` in `browser_tabs` schema

## 1.4.1 — 2026-03-14

- fix: shared dependency resolving to unrelated npm package with critical vulnerabilities

## 1.4.0 — 2026-03-13

- feat: daemon architecture — standalone coordinator process with Unix socket IPC
- feat: multi-session multiplexing via daemon with round-robin scheduling
- feat: profile system (`ProfileRegistry`, `Matchmaker`, managed Chromium instances)
- feat: audit logging — always-on NDJSON trail for every tool call

## 1.3.1 — 2026-03-13

- chore: file cleanup

## 1.3.0 — 2026-03-13

- chore: file cleanup, repo reorganization

## 1.2.0 — 2026-03-12

- chore: cache flush, repo maintenance

## 1.1.0 — 2026-03-07

- security: updated packages with security fixes

## 1.0.2 — 2026-03-07

- chore: maintenance

## 1.0.1 — 2026-03-04

- chore: file cleanup

## 1.0.0 — 2026-03-04

- feat: stable release — MCP browser automation via Chrome extension + local server
- feat: full tool suite: interact, evaluate, snapshot, lookup, navigate, tabs, screenshot, extract, fill_form, drag, window, dialog, verify, network requests, console messages, PDF save, performance metrics, downloads
- feat: `:has-text()` pseudo-selector support in `browser_interact`
- feat: `browser_lookup` — find elements by visible text, return selectors + coordinates
- feat: page diffing (experimental) — DOM diff with confidence scoring after interactions
- feat: smart waiting (experimental) — DOM stability detection

## 0.7.1 — 2026-02-25

- fix: README extension install instructions
- fix: updated file references

## 0.7.0 — 2026-02-25

- feat: welcome page
- feat: port cleanup, idle timeout
- feat: mux status reporting

## 0.6.7 — 2026-02-24

- chore: maintenance

## 0.6.6 — 2026-02-23

- chore: added GitHub page

## 0.6.5 — 2026-02-20

- chore: updated README

## 0.6.4 — 2026-02-19

- security: harden `secure_eval` against pentest bypasses
- feat: add rollback flag to `version.bump`

## 0.6.3 — 2026-02-18

- chore: maintenance

## 0.6.1 — 2026-02-17

- chore: updated logo + UI

## 0.6.0 — 2026-02-17

- feat: domain whitelisting — pulls daily from Tranco top 100K, opt-in via popup

## 0.5.2 — 2026-02-16

- security: fix `secure_eval` checks being bypassed by adversarial JS

## 0.5.1 — 2026-02-16

- fix: click navigation timing
- fix: screenshot timing
- fix: eval return values
- fix: page diffing accuracy
- fix: smart waiting reliability
- fix: error messages

## 0.5.0 — 2026-02-15

- feat: `secure_eval` experimental feature — AST-based code analysis for `browser_evaluate` using acorn; blocks network calls, storage access, code injection, and obfuscation patterns before execution

## 0.4.0 — 2026-02-14

- feat: `mouse_humanization` experimental feature — Bezier path generation, randomized personality traits
- feat: improved debug logging — per-session log files, parameter visibility on CDP/WS commands, truncation
- chore: removed `env-paths` dependency

## 0.3.0 — 2026-02-13

- feat: `storage_inspection` experimental feature — localStorage/sessionStorage inspection

## 0.2.1 — 2026-02-12

- chore: further modularization, improved testing

## 0.2.0 — 2026-02-11

- feat: multiplexing experimental feature
- chore: modularized codebase

## 0.1.0 — 2026-02-10

- feat: initial release
