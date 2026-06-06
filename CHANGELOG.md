# Changelog

All notable changes to SuperSurf are documented in this file.

Format: `feat` = new capability, `fix` = bug fix, `security` = hardening, `chore` = maintenance.

## Unreleased

- **BREAKING: feat**: single-package consolidation — the `supersurf-mcp` and `supersurf-daemon` npm packages are replaced by one `supersurf` package with subcommand routing (`supersurf mcp` / `supersurf daemon` / `supersurf creds`) via a bin dispatcher (`server/src/bin/`). The daemon is now bundled into the server (`server/dist/daemon/`) and `daemon-spawn` launches the bundled copy via `process.execPath` — no more `npx supersurf-daemon@latest` network fetch. The old `supersurf-mcp`/`supersurf-daemon` bin names still work as deprecated aliases that print a stderr notice and forward to the dispatcher. Existing MCP configs pointing at `npx supersurf-mcp@latest` keep resolving the frozen v2.1.0 package until updated to `npx supersurf@latest mcp`. The `mcp` subcommand must be explicit: a bare `supersurf` (or `--help`/`-h`) now prints usage to stdout and exits 0 instead of silently starting the stdio server, and an unrecognized command prints usage to stderr and exits 1
- **BREAKING: feat**: a v3 server now refuses to attach to a daemon of a different version. On `connect`, if the running daemon's version (sent on the `session_ack` handshake) does not match the server — or the daemon predates the version field — `connect` returns a `version_mismatch` error instructing `npx supersurf daemon restart`. Prevents a fresh v3 server from silently driving a stale v2 daemon (protocol skew). A freshly-spawned bundled daemon always matches, so this only fires during an upgrade while an old daemon is still alive
- fix: managed-profile `connect` race — the daemon now opens the profile registration URL on **every** managed spawn, not just the first. Previously the registration page was gated behind `isFirstLaunch` (`!registry.isInitialized(profile)`), so re-spawning an already-initialized profile whose extension `chrome.storage.local` had lost `supersurf_profile` (force-kill, rsync'd macOS profile, Chrome corruption) handed the daemon a handshake with no `profile` field → the connection was pooled as `unmanaged`, the pending managed match never resolved, and `connect` timed out after retries (per-profile experiments like `mouse_humanization` silently never applied). Re-serving the registration page on every spawn re-arms the profile binding in extension storage and triggers the existing `storage.onChanged` → reconnect path. Companion guard: the extension's `storage.onChanged` listener now reconnects only when `supersurf_profile` actually changes, so re-arming on a healthy re-spawn (storage already correct) no longer tears down an already-matched connection. Note: the doc-proposed persistent-cookie fix would not have helped — on the failing path no registration page is served at all, so no cookie (session or persistent) is ever set
- fix: `browser_handle_dialog` no longer hangs when a native dialog has already fired. The tool was preventive-only — it injected MAIN-world `alert`/`confirm`/`prompt` overrides via `chrome.scripting.executeScript`. Once a real dialog opened, the renderer's JS thread froze and `executeScript` couldn't run, so the call would time out at 30s. The handler now fires `Page.handleJavaScriptDialog` via CDP first (CDP bypasses the frozen JS thread), unfreezes the renderer, then re-injects the overrides. Surfaced by audit-log review where agents on Phenom Aurelia ATS pages (resume parser fires a native dialog before injection) repeatedly hit the timeout
- fix: auto-handle default for `confirm()` flipped from `accept=true` → `accept=false`. Auto-accepting confirms is destructive in too many cases (delete account, submit form, leave page); auto-dismissing is almost always safe. Agents that need accept call `browser_handle_dialog { accept: true }` explicitly
- feat: dialog events now ride every tool response via a `_dialogs` envelope (mirrors the existing `_recovery` envelope pattern). When a page fires a dialog during any tool call, the response status header now includes a `⚠ dialog fired: <type>: "<message>" → <response>` line per event — no polling required. Agents see exactly what the page asked for and how it was answered
- fix: `_dialogs` envelope was only being unwrapped inside `formatResult` (the MCP-envelope path used by ~6 tools), so dialogs that fired during `browser_interact`, `browser_navigate`, `browser_evaluate` etc. silently dropped on the floor. Moved aggregation to a per-dispatch hook in the tool dispatcher: `DaemonClient` strips `_dialogs` off every JSON-RPC response into a session buffer, and the dispatcher drains that buffer in its `finally` and prepends one consolidated notice — so multi-step tools that issue several extension RPCs per call surface every dialog fired across the dispatch
- fix: drain-tick race in the extension's dialog buffer. The previous implementation called `getDialogEvents` then `clearDialogEvents` as two separate `chrome.scripting.executeScript` invocations, and two consecutive 500ms drain ticks could both read the same events before the prior tick's clear landed — producing duplicate `⚠ dialog fired` lines in the agent-facing notice. Replaced with atomic `drainDialogEvents` that reads and clears `window.__supersurfDialogEvents` in a single MAIN-world execution
- fix: `setupDialogOverrides` injection failures (e.g. `chrome://` URLs, detached tabs) now propagate to the caller instead of being silently logged-and-swallowed. The old swallow masked real attachment bugs as no-ops
- feat: OS keychain credential store + `supersurf creds` CLI. New `shared/keychain` module abstracts a `KeychainBackend` (`add`/`get`/`list`/`remove`) over the platform keychain — macOS via the `security` CLI (`add-generic-password`/`find-generic-password`/`dump-keychain`), Linux via `secret-tool` (libsecret/Secret Service) — plus an `InMemoryKeychainBackend` for tests. All items are namespaced under `service="supersurf"` (the `SUPERSURF_SERVICE` constant), so SuperSurf only ever reads/writes its own credentials. New CLI surface routed through the bin dispatcher on the first positional arg: `supersurf creds add <name> [--domain <d>]` (reads the value from stdin, hidden in a TTY; never echoes), `supersurf creds list` (prints names + optional domain only — **values are never displayed**), and `supersurf creds rm <name>`. On unsupported platforms `getKeychainBackend()` throws and directs the operator to env-var fallback. **Storage layer + CLI only** — wiring the keychain into the `secure_fill` resolver chain (so fills resolve from keychain before `.env`) is a separate follow-up and is **not** in this change
- feat: config-drift warning — daemon now `fs.watch`es `~/.supersurf/config.json` post-startup, hashes the file at boot, and flips a drift flag when the on-disk hash diverges from the snapshot loaded at startup. The flag rides the IPC envelope (`config_drift: true` on `session_ack` and every JSON-RPC response). Server prepends a one-shot warning to the status header: `⚠️ ~/.supersurf/config.json changed since daemon start — config edits will not take effect until restart: npx supersurf daemon restart`. One-shot per MCP session (sticky-suppressed after first emission to avoid spam); reset on session restart. Motivation: config changes silently require a daemon restart, and operators kept editing `config.json` mid-session expecting hot-reload that doesn't exist
- feat: `profiles.startup_opts.disable_gpu` config knob — when set to `true` in `~/.supersurf/config.json`, the daemon appends `--disable-gpu` to every managed-profile Chromium spawn. Stability/compat lever for systems with flaky GPU drivers (black tabs, renderer crashes); **not** a performance win — disabling hardware compositing usually regresses scrolling and canvas/WebGL perf, so leave it `false` (the default) unless you have a concrete stability reason to flip it. Single global knob, no per-profile override. Requires daemon restart
- chore: `scripts/publish.ts` preflight now checks publish auth as a prerequisite before doing any release work — validates CWS client credentials + refresh-token freshness and npm-registry login (`npm whoami`), failing fast with the exact remediation command (`npm run cws.auth` / `npm login`) instead of partway through a release
- chore: `npm run smoke.pack` — npm-pack self-containment gate. Packs the `supersurf` tarball, installs it into a throwaway temp dir (no workspace symlinks), and `require()`s the bundled daemon + bin entrypoints under `VITEST=1` (so it never starts a real daemon or touches `~/.supersurf/`). Fails loudly if any bundled module is missing — catches an unshippable bundle that dev-time workspace symlinks would otherwise hide. Run before publishing

## 2.1.0 — 2026-05-22

- feat: `profiles` graduated from experiment to default behavior. Managed Chromium profiles, `profile_create`/`profile_list`/`profile_delete` MCP tools, and the connection-pool matchmaker are now always available — no `experiments.profiles: true` in `~/.supersurf/config.json` required. Decision data: 38,275 tool calls across 36 sessions / 11 versions, 95.9% success rate. No opt-out hatch — the single-connection-only daemon mode is retired; operators who do not need profile isolation can simply ignore the new tools or connect without the `profile` param (the "bring your own Chromium" path)
- BREAKING: removed `experiments.profiles` config key. Setting it in `~/.supersurf/config.json` will emit an "unknown top-level key" warning and otherwise be ignored. `SUPERSURF_EXPERIMENTS=profiles` likewise warns and is ignored
- BREAKING: removed `capabilities.profiles` from the daemon's `session_ack` handshake. MCP servers no longer guard profile tools on this capability — the gate is always open
- chore: added regression-lock tests asserting `profiles` is not present in `Config['experiments']`, not in `KNOWN_EXPERIMENTS`, and not in `DaemonExperimentRegistry.AVAILABLE_EXPERIMENTS`

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
