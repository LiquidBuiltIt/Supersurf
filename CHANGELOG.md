# Changelog

All notable changes to SuperSurf are documented in this file.

Format: `feat` = new capability, `fix` = bug fix, `security` = hardening, `chore` = maintenance.

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
