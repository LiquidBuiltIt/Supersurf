<!--
CHANGELOG PARSER CONTRACT — read before editing. Parsed by scripts/changelog.ts
(`npm run changelog`). This is regex-driven: deviate and an entry is either
silently mis-rendered or silently dropped with no error.

1. Section headers MUST start with exactly "## " (two hashes, one space) at
   column 0.
   - Unreleased: exactly `## Unreleased` (case-insensitive) — nothing else on
     that line, no trailing date/text.
   - Released:   `## X.Y.Z` then anything — e.g. `## 3.2.0 — 2026-07-03`. Only
     the three dot-separated integers are read; everything after is free text.
   - Any other "## " header (typo, missing patch digit, extra text on the
     Unreleased line) is SILENTLY DROPPED — header and every bullet under it
     vanish with no error.
2. Use an em dash "—" (not a hyphen) before the date. Section splitting
   doesn't care, but `npm run changelog -- ls`'s date column only recognizes
   the em-dash form.
3. Do NOT use "### " subsections (e.g. "### Added" / "### Changed"). The
   parser has no concept of them — a "### " line isn't a header at all, so
   its bullets silently collapse into the flat bullet list of whichever
   section they sit inside, with the category label lost. One flat bullet
   list per section, period.
4. Entries are top-level bullets: "- " or "* " at column 0, no leading
   indentation — indented/nested bullets are invisible in the default
   (non-verbose) view.
5. Lead each bullet with a **bold** summary phrase, or a sentence ending in
   . ! or ? — that's what the default compact view extracts as the one-line
   change statement.
-->

# Changelog

All notable changes to SuperSurf are documented in this file.

Format: `feat` = new capability, `fix` = bug fix, `security` = hardening, `chore` = maintenance.

## Unreleased

- feat: `supersurf playbook run <name> [--profile <p>] [--json]` replays a saved playbook without an MCP client — it drives the same `ConnectionManager` (connect → `playbooks` tool `action:'run'` → disconnect) as `--script-mode`, so there is one playbook runner regardless of caller. `--profile` picks a managed profile (falls back to the playbook's own `profile` field, then none); `--json` prints `{name, success, output}`. Exits 0 only when no step failed; a failed step, a missing playbook, or a connect failure all exit 1, with a matching stderr message. Always disconnects, including on SIGINT.
- feat: two new contextual tips nudge agents toward `playbooks` — `playbooks-milestone` fires once per session when the action trail reaches 8 entries, and `playbooks-repeat` fires once per session when the last 3 actions repeat an earlier non-overlapping 3-action sequence spanning at least 2 distinct tools. Both fire on any tool call (except `playbooks` itself) and show a different message when the `fingerprinting` experiment is off.
- feat: `supersurf playbook edit <name>` no longer requires `--drop` — without it, the playbook opens in `$VISUAL`/`$EDITOR` for a free-form edit, validated (version 1, non-empty steps) and saved back on exit; renames are ignored (name stays fixed) and a non-TTY session without `--drop` errors with a clear message.
- fix: `playbook edit` no longer silently falls back to `vi` — if neither `$VISUAL` nor `$EDITOR` is set, or the configured editor fails to launch, the error names the direct playbook file path and the `--drop <step>` alternative instead of a misleading "Editor exited with status 1".
- chore(release): `version.bump` now auto-cuts the Unreleased changelog section into the new version's heading (em-dash date), leaving a fresh empty Unreleased
- feat: major-version upgrade notice — CLIs and the `connect` tool now greet you after a major update with a pointer to the changelog, tracked via `~/.supersurf/version-state.json` (stderr-only in MCP/script modes so the JSON-RPC stream stays clean)
- feat(extension): changelog page on major updates — `onInstalled` update with a major-version jump opens a bundled changelog view of everything since your previous version; welcome page still greets fresh installs. Content is emitted at build time by the new `npm run changelog -- json` subcommand.
- fix(sandbox): `sandboxPath` no longer silently relocates out-of-$HOME save paths — an absolute path already inside $HOME is honored as-is (fixes a double-prefix bug where e.g. `$HOME/x.png` was rewritten to `$HOME$HOME/x.png`), and any path (absolute or `..` traversal) that resolves outside $HOME now throws a clear, actionable error instead of being quietly rewritten under $HOME. `browser_take_screenshot`, `browser_pdf_save`, and `browser_download` callers are unaffected, unchanged.
- **feat: per-action IDs** — every `browser_interact` action now carries a numeric ID (shown as `#NNNN` prefix in results); `browser_interact` mints one ID per action in its array, every other browser tool mints one per call. IDs are sequential within a session and enable step-by-step playbook workflows.
- **feat: `playbooks` MCP tool** — record and replay user-confirmed action sequences. Three methods: `history` lists the session's numbered actions grouped by route (no fingerprinting required); `create` freezes a cited sequence of action IDs into a saved playbook (requires `fingerprinting` experiment); `run` executes a saved playbook in order and stops at the first failure (requires `fingerprinting`). Emits step outcomes to the usage-metrics trail.
- **feat: `supersurf playbook` CLI** — human-facing playbook management without the daemon. Commands: `ls` (list playbooks), `show <name>` (display steps), `edit --drop <step> <name>` (remove a step), `rm <name>` (delete), `export <name>` (copy to stdout), `import [--name <alias>]` (read from stdin). Playbooks are stored one file per playbook at `~/.supersurf/playbooks/<name>.json` with mode 0600.
- Playbooks now replay every trail-recorded tool, not just `browser_interact`: `create` accepts any id from `history`, `run` re-issues navigate/extract/tabs/etc. with their frozen params (read-tool output is included in the run result), and the start-URL auto-navigate is skipped when step 1 is itself a navigate or a `browser_tabs new`. Without the tab-new skip, `run` failed with "No attached tab" on a fresh session and otherwise loaded the start page twice.
- **feat: fingerprint healing now covers every selector-resolving `browser_interact` verb** — `click`, `hover`, `drag`, `type`, `clear`, `select_option`, `select_custom`, `scroll_to`, `scroll_by`, `scroll_into_view`, and `file_upload`, plus `browser_fill_form` fields. Two exceptions: `force_pseudo_state` (drives CDP directly off a raw `objectId`, nothing to heal against) and `wait` (polls for the original selector to appear — healing a miss would end the wait early).

## 3.3.0 — 2026-08-05

- fix(keep-browser): session-end browser kill now fails closed — a profile whose extension connection isn't pooled at disconnect (mid-reconnect blip) is killed like any other unless the user opted into keep-browser (was: silently kept alive, violating the opt-in default)
- fix: do not auto-close the managed-profile registration tab — closing the sole startup tab quit Chromium (exit 0) right after a successful `connect`, so `browser_tabs` failed with `No extension connected for profile …`. Registration page now stays open with a success UI (“Profile ready”); user may close it manually. *(contributed by @df007df in #14)*
- feat: extension Settings “Keep browser after session ends” (**opt-in**, default off) — when enabled, daemon skips SIGTERM on last MCP session disconnect; idle/shutdown/orphan kills unchanged *(contributed by @df007df in #14)*
- feat(extension): persist Chrome Tab Groups by `client_id` across MCP disconnect — idle groups stay titled and turn grey; reconnect reclaim restores the prior active color from `chrome.storage.local` *(contributed by @df007df in #14)*
- **feat: `screenshot.omit_path` in `~/.supersurf/config.json`** (`inline` \| `path` \| `both`, default **`inline`**) — controls `browser_take_screenshot` when `path` is omitted. `path` saves under `$TMPDIR/supersurf-screenshots/` (text only); `both` saves and returns an inline image. Explicit `path` still wins. Env: `SUPERSURF_SCREENSHOT_OMIT_PATH`. Internal `rawResult` captures stay inline. *(contributed by @df007df in #14)*
- **feat: `profiles.chrome_path` in `~/.supersurf/config.json`** — set an absolute Chrome/Chromium binary for managed-profile spawns (skips PATH auto-detect). `null`/omit keeps auto-detect. Also probes macOS `/Applications/Google Chrome.app/...` and Chromium.app. Requires daemon restart. *(contributed by @df007df in #14)*
- fix(interact): `type` action now inserts real line breaks for `\n` in multi-line text (dispatches the Enter keyDown/keyUp pair instead of a silently-dropped `char` event; CRLF normalized to a single Enter)
- fix(lookup): `browser_lookup` now rejects a missing/blank `text` argument with a clear error instead of crashing in page context with `Cannot read properties of undefined (reading 'trim')`
- **change(playbooks): `browser_interact`'s `name` and `purpose` are documented as required for element-targeting actions (click/type/clear/hover/select_option/select_custom/file_upload), carried as prose in the field descriptions — not as a JSON Schema rule.** Without some requirement agents named elements inconsistently, and a corpus full of unnamed records makes resolve-by-name unusable. A conditional `allOf`/`if`/`then` block was briefly used to express this structurally and has been **removed before release**: the MCP spec restricts tool `inputSchema` to `type`/`properties`/`required`, composition keywords are not part of it, and client support is unreliable — the failure mode is the entire tool vanishing from `tools/list`, not a soft degrade. It also bought nothing to offset that risk, since this server never validates tool inputs (the low-level SDK `Server` checks only the `{name, arguments}` envelope), so the rule was advisory even where clients honored it. The item-level `required` array stays at `['type']`; a test walks the whole schema and fails on any composition keyword at any depth. Whether prose alone is enough to get agents to supply names is now an open question to answer with telemetry, not an assumption. A malformed name is still normalized server-side, never rejected.
- **feat(playbooks): `browser_snapshot` and `browser_lookup` now show the handle you recorded for an element instead of just its selector.** An element previously named through `browser_interact`, whose selector shape matches the stored selector or a derived `tag#id` / `tag[name="…"]` key, renders as `first_name_input [input#fname]` — handle first, the CSS kept alongside so there is always a working fallback. Class-keyed selectors (`div.a.b`) are deliberately not indexed and render unannotated, as does any element with no recorded handle — byte-identical to before. This closes the discovery gap the resolve-by-name round left open: an agent could previously only use a handle it had named itself in the same session. Scoped to output that actually carries a selector — `browser_lookup` matches and `browser_snapshot`'s Form Fields section; the accessibility-tree lines are untouched because CDP AX nodes carry no selector to match on. One corpus read per tool call, never one per node. Gated behind `fingerprinting`; no-op when off.
- **fix(playbooks): a single-word `name` (no underscore, e.g. `"submit"`) is no longer stored as a handle.** It normalized and persisted fine, but `looksLikeHandle` requires an underscore, so resolution would never recognize it as a handle and it would parse as a (non-matching) CSS tag selector — an element could end up permanently displaying a name that could never resolve back to it. `mergeHandleMeta` now rejects a normalized name that fails `looksLikeHandle` (`outcome: 'none'`, canonical left untouched — never rejects the tool call), and `buildHandleIndex` additionally filters out any single-word `handleName` already present in a corpus from before this fix.
- **perf(fingerprinting): the fingerprint corpus is no longer re-read and re-parsed on every lookup.** `loadDomain` previously did a `readFileSync` + full `JSON.parse` per call, and `getRecord`/`putRecord` each called it again internally — so a capture on a plain selector cost 2 complete parses of the domain file (`getRecord` + `putRecord`) and a capture on a resolved handle cost 3 (the handle-resolution `loadDomain` plus the same `getRecord` + `putRecord` pair). It now memoizes the parsed store, guarded by the file's mtime **and** size so a write from another server process (one per MCP client, all sharing the corpus) is picked up on the next read rather than served stale.
- **change(fingerprinting): handle aliases are gone — the first name an element is given is permanently sticky.** Previously a differing `name` on an already-named element was harvested into a frequency-counted `aliases` map on the record and *resolved* through a second matching tier below canonical. That map duplicated a signal the usage-metrics trail already carries, and gave a loosely-reused name a path to bind to an element it was never the canonical name for. A differing name is now a true no-op: nothing is persisted, canonical is untouched, and resolution has a single canonical tier. The drift is still observable — `handle.capture` now emits `outcome: "ignored"` with the discarded name in `ignoredName`. The `handle.alias_added` event and the `aliases` record field are removed.
- **fix(page_diffing): `capturePageState` now injects into the MAIN world — the shadow-piercing capture below was inert without it.** `extension/src/experimental/index.ts` called `chrome.scripting.executeScript({ target, func, args })` with no `world`, so the capture walk ran in the default **isolated** world, where it returned zero open shadow roots. Net effect: every shadow-DOM mutation — adds, removes, text edits, attribute edits, visibility toggles, even a 50-node bulk append — diffed as `No visible changes detected.` at **100% confidence**. A silent false negative, not an error: an agent reading the diff would conclude its click did nothing. Measured against a ground-truth harness (10 known mutations, one per click): **2/10 before, 10/10 after**; the only remaining miss is a closed shadow root, which is unreachable from script by design. The extension's two other `executeScript` sites (`background.ts`, `handlers/console.ts`) already passed `world: 'MAIN'`; capture was the outlier.
- **fix(page_diffing): capture now pierces open shadow roots instead of only counting shadow hosts.** `capturePageState` previously incremented `shadowRootCount` on every `el.shadowRoot` hit but never descended into it, so shadow-heavy pages (measured ~34% of elements captured on reddit.com) were silently undercounted. It now walks breadth-first through open shadow roots (light DOM first), applying the same visibility/text/form-value extraction inside each — closed shadow roots (`el.shadowRoot === null`) still degrade silently, no throw. `page-diffing.ts`'s `(partial — shadow DOM present)` label and the confidence penalty for `shadowRootCount` are removed accordingly (closed roots remain undetectable from script, so no penalty/label can honestly target them); the iframe partial-capture reason is untouched.
- **fix: selector-based tools (`browser_interact`, `browser_fill_form`, `getElementCenter`) now pierce open shadow roots.** `getSelectorExpression` previously built a plain `document.querySelector(...)` string, blind to anything nested inside a shadow root. It now wraps the query in a light-DOM-first, shadow-descending walker (`queryDeep`/`queryAllDeep`, `shared/dom/shadow-walker.ts`) — an existing selector still resolves to the same light-DOM element (shadow roots are only walked on a miss), but a selector previously invisible inside a shadow root now resolves.
- fix(fingerprinting): resolve telemetry no longer hardcodes `hadRecord: false` on the happy path — a hoisted (not duplicated) `getRecord` lookup now reports truthfully whether a fingerprint already existed for the selector, and every `fingerprint` event adds a `discovery: 'new' | 'known'` field derived from it, unblinding cold-start-vs-known-element analysis in `/usage-data-audit`.
- **Named capture (playbooks write-side):** `browser_interact` actions now accept `name` (snake_case handle identity) and `purpose` (intent) fields. When the `fingerprinting` experiment is on, these bind to the element's fingerprint record on every element-targeting `browser_interact` action (click/hover/type/clear/select_option/select_custom/file_upload) via a centralized capture path shared by the coordinate and context resolvers — first-seen name is canonical and permanently sticky; a later differing name is a no-op. Emits `handle.capture` events to the usage-metrics trail. Gated behind `fingerprinting`; no-op when off. Never rejects a missing/malformed name (normalized server-side).
- **`supersurf export` command** — bundles usage-metrics logs (`metrics-*.ndjson` + legacy `audit-*.ndjson`) from `~/.supersurf/logs/sessions/` into a timestamped `.zip` in the current directory. Shells out to the OS `zip` CLI; no redaction (logs ship as-stored, already redacted by the usage-metrics logger).
- **fix: `browser_verify_element_visible` and `browser_extract_content` (selector mode) now pierce open shadow roots too.** Both hand-rolled their own `document.querySelector(...)` instead of routing through `getSelectorExpression`, so they were still blind to shadow-nested elements after the shadow-piercing walker landed for `browser_interact`/`browser_fill_form`/`getElementCenter`. Same non-breaking guarantee: an existing selector still resolves to the same light-DOM element.
- **Resolve-by-name (playbooks read side, round one)** — any selector field on `browser_interact` (and `browser_get_element_styles`, `browser_fill_form`, `browser_extract_content`, `browser_verify_element_visible`) now accepts a handle you named earlier: pass a bare multi-word `snake_case` name like `tweet_button` and the server resolves it to the element that name was fingerprinted against, healing on a page change. Multiple records can legitimately carry the same canonical name; ties break on hit count then recency. An unrecognized name falls through to the normal CSS path and the not-found error gains a line explaining that no such handle was recorded. Single-word names are always read as CSS tag selectors. Gated by the `fingerprinting` experiment. Emits `handle.resolved` (name, match tier, candidate count) to the usage-metrics trail.
- **Fingerprint match scorer now returns the winning element's identity** (`role`, `name`, `tag`, `type`, `htmlId`, `attrs`, `classList`, `ordinal`) alongside its coordinates and score. Previously it computed all of it in-page and serialized only `{cx, cy, score, margin}`, which made a healed match impossible to turn back into a selector.

## 3.2.0 — 2026-07-03

- **fix: the `daemon` control CLI was completely dead — `supersurf daemon status|stop|restart|observe` crashed with `Cannot find module '../daemon/main'`.** The bin dispatcher (`server/src/bin/dispatcher.ts`) imported `../daemon/main`, which resolves to `server/dist/daemon/main` — a bundle-copy target (`scripts/daemon.bundle.ts`) that was **never wired into any build script**, so the file never existed. Net effect: there was no working way to stop/restart a wedged daemon via CLI; the only recovery was manually killing the PID on port 5555. The dispatcher now resolves the daemon the same way `daemon-spawn.ts` already does — through the `supersurf-daemon` package (`resolveDaemonEntry()`), which works in both local dev (workspace symlink) and a published install. Regression-locked: a test asserts the resolved daemon entry exists on disk. The dead path was invisible to CI because `bin-dispatcher.test.ts` only exercised `pickTarget`/`HELP_TEXT`, never `dispatch()`.
- **fix: a wedged daemon holding port 5555 now fails fast with the real reason instead of a blind 10s timeout, and `status` surfaces it.** Previously the daemon was spawned `stdio: 'ignore'`, so when it hit `EADDRINUSE` binding 5555 (e.g. a stale daemon already on the port) it `console.error`'d into the void and `exit(1)`'d, while `ensureDaemon` polled only for the socket file — burning the full 10s before throwing a generic "Daemon failed to start within 10 seconds." Now `ensureDaemon` captures the daemon's stderr to `~/.supersurf/daemon.startup.log`, watches the child for an early exit, and the instant it dies throws an actionable message (`port 5555 is already in use (EADDRINUSE) — … stop it with npx supersurf-daemon@latest stop …`) via the new exported `explainStartupFailure()`. The failure reason is stored on the connection manager (`lastConnectError`) and rendered in the passive `status` header (`⚠️ Last connect failed: …`), so `status` reports the port conflict instead of a bare cached "Disabled". Transparent-core: it **reports** the wedged port and lets the operator/agent act — it does **not** auto kill+rebind (that opinionated self-heal stays deferred to opt-in smart mode).
- **feat: `browser_interact` `click` now reports whether the click actually *did* anything, instead of always claiming success.** Previously a click that dispatched returned `Clicked <target>` unconditionally — even when an overlay swallowed it or the handler never fired, the agent was told it worked. The click now arms a page-context probe before dispatching (a one-shot capture listener on the resolved target + a subtree `MutationObserver` + a focus/URL/aria snapshot) and reads it back after the event settles, walking a confidence ladder: **dispatched → reached-target → produced-side-effect**. Outcomes: an observable change (DOM mutation, focus move, URL change, aria change, or a spawned tab) → `✓ Clicked`; the event reached the element but nothing changed → `⚠ … the event reached the element but nothing observable changed`; the event never reached the element → `⚠ … the synthetic click did not reach the element (overlay/stale coords)`. The capture listener only proves *delivery* to the element, **not** that React's root-delegated `onClick` ran — which is exactly why the `MutationObserver`/focus/aria window is the real side-effect signal, not the listener alone. Transparent-core: it **reports** the miss and lets the agent decide; it does **not** auto-retry or escalate the input method (that opinionated behavior is deferred to opt-in smart mode — see `smart-mode-roadmap-2026-06` B7). Probe is best-effort and never throws into the click path; on a child-frame edge, eval error, or no element under the cursor it stays silent rather than emit a false warning. Adds no new sleep (reuses the existing `detectSpawnedTabs` ~300ms settle).

- **fix: `browser_navigate` `back`/`forward` no longer hang on SPA renderer-pegging pages (e.g. X/Twitter `/compose/post`).** The post-navigation URL read was an *in-page* `eval('window.location.href')`, which runs on the renderer main thread. SPA routes like X's compose modal tear down a heavy React subtree synchronously in their `popstate` handler, pegging that thread for tens of seconds — so the in-page read queued behind the teardown and blocked until the ~50s eval timeout (a ~17s real-world hang was reproduced; the synthetic repro hit ~61s). The URL is now read from the **browser process** via `getTabs` (`chrome.tabs.query` + cached metadata — never touches the renderer), so `back`/`forward` return the post-nav URL instantly even while page JS is frozen. Proven with a CDP spike: browser-process read 0ms vs in-page read 7.8s under an 8s peg. Surgical — only the back/forward URL reads changed; `url`/`reload` are untouched. (Note: `smart_waiting`'s `waitForReady` already bounds its own wait at 10s, so the residual worst case is ≤10s, not the eliminated ~50s.)
- fix(fingerprinting): captures now land under the correct domain instead of silently mis-filing into `unknown.json`. **Root cause:** after a mid-session extension reconnect the server nulled `attachedTab` and never restored its URL — `onTabInfoUpdate` ignored updates while the tab was null, and `onReconnect` only cleared state — so every subsequent capture read an empty URL and keyed to `domain: "unknown"`. Now `onReconnect` re-queries `getTabs` to rehydrate the attached tab (URL included), and `onTabInfoUpdate` rebuilds the snapshot even from a null state (`backend/handlers.ts`, extracted as testable `rehydrateAttachedTab` / `applyTabInfoUpdate`).
- fix(fingerprinting): `file://` pages now key to a dedicated `file` bucket with the path as route (was collapsing into `unknown`), and `captureOnResolve` hard-drops any capture that still resolves to `domain: "unknown"` — the `unknown.json` bucket is unhealable (heal keys off the live domain) so writing to it is pure noise. Garbage/`about:blank`-style URLs go to the void instead of polluting the dataset.
- **Native dialogs are now held, not auto-answered.** `alert`/`confirm`/`prompt`/`beforeunload` are caught via CDP `Page.javascriptDialogOpening` and held open (the renderer stays blocked until resolved); the triggering tool's own result surfaces the dialog in the `_dialogs` envelope (`⚠ A native <type> dialog is OPEN and blocking the page…`), and the agent resolves it with `browser_handle_dialog {action: "view" | "accept" | "dismiss"}` (legacy `accept: boolean` still maps: true→accept, false→dismiss). This **supersedes** the 3.0.1 approach (MAIN-world `alert`/`confirm`/`prompt` stub injection + auto-dismiss-`confirm` default + the `⚠ dialog fired → <response>` notice): there are no MAIN-world stubs and nothing is auto-answered. Fixes the `beforeunload` renderer-freeze — `beforeunload` has no `window.*` method to stub, so under the old model it reached the native CDP path with nothing listening and froze the renderer indefinitely; an in-flight command that triggers a dialog now returns immediately (the CDP event fires on the service-worker thread and resolves a race) instead of hanging to timeout, and subsequent page-touching commands short-circuit with a clear "resolve the dialog first" error while one is held. Auto-answering is removed from the transparent core and deferred to a future opt-in **smart mode** (see `smart-mode-roadmap-2026-06`).
- fix: **parallel-agent tab collision (Tier 1).** Concurrent subagents share one MCP session, so every tab-scoped tool resolved against the extension's single shared `attachedTabId` global — a sibling agent switching tabs would silently redirect another's in-flight call (a TOCTOU race). Tab-scoped tools now accept an explicit `tabId` param (pin it from `browser_tabs` so a sibling can't steer your call; omit to use the session's attached tab). Threaded end-to-end with **no per-handler duplication**: server side, `tabId` rides `ToolContext` (`args.tabId` → `buildContext(tabId)` → baked into `ctx.cdp`/`ctx.eval`) so the universal `cdp()` chokepoint in `tools/lib/cdp.ts` forwards it for the entire selector/eval/CDP surface; the few direct-`sendCmd` tools (snapshot/screenshot/window/dialog/perf/secure_fill/navigate) forward `ctx.tabId` explicitly. The `tabId` schema property is injected programmatically over a `TAB_SCOPED` set (one definition, not ~16 copies). Extension side, the single `ensureAttachedTab(explicitTabId?)` resolver honors an override **without mutating the shared global** (the correctness crux — a pin must not flip a sibling's view) and throws a clear error if the pinned tab is gone. Tier 2 (per-tab keying for the global console/network/dialog/spawned-tab buffers) is deferred to a separate change.

## 3.1.0 — 2026-06-14

- chore: closed the `supersurf` npm name-squat dispute as **abandoned**. npm Trust & Safety refused to review the squatting claim (2026-06-09, quoting policy: "we will not review squatting claims... trademark is the only path we act on"); registering a USPTO mark to force the issue isn't worth it for a FOSS name. The single-`supersurf` merge is **cancelled** (was "deferred" in 3.0.1) — SuperSurf ships permanently as `supersurf-mcp` + `supersurf-daemon`. CLAUDE.md callout updated; the `supersurf-npm-namesquat-dispute-2026-06-07` stickynote is closed/historical
- Added `fingerprinting` experiment (default off): captures a multi-signal fingerprint of resolved elements to `~/.supersurf/fingerprints/{domain}.json` and heals `browser_interact` selector misses by re-finding the element by meaning. Gated via `experiments.fingerprinting` / `SUPERSURF_EXPERIMENTS=fingerprinting`. Heals only on score ≥ 0.6 AND margin ≥ 0.10 (fail-safe → escalate otherwise). Scope: `getElementCenter` path (click/hover/drag), top frame **and** iframes (capture + heal); fill-form not covered. Capture resolves selectors via `getSelectorExpression` so `:has-text(...)` and digit-leading-id selectors fingerprint correctly. Emits per-resolve telemetry to the usage-metrics trail (`tool: "fingerprint"`, `outcome: resolved|healed|escalated`, with selector/domain/route/score/margin/hadRecord) for `/usage-data-audit`.
- **Unified action recorder (core, gated by `logging.usage_metrics`).** A recorder wraps the single `executeAction` chokepoint and logs, per `browser_interact` action, what was targeted (selector and/or x,y) and what happened (ok/error + message + duration) to the usage-metrics trail under `tool: "action"`. Gated solely by the existing `logging.usage_metrics` leaf — no separate `logging.action_recording` leaf (removed). Adds per-action granularity beyond tool-level `usage_metrics`. Records only — it does not fingerprint or resolve elements; fingerprinting/self-healing are future consumers of this chokepoint. See stickynote `self-healing-coordinate-capture-roadmap-2026-06`.
- fix(fingerprinting): `accName` now lifts the `value` attribute into the captured element name for `radio`/`checkbox`/`submit`/`button` inputs, where `value` is the human-meaningful static label. Previously these captured an empty `name` (the meaningful text — e.g. "Choose not to disclose", "No, I am a US Citizen" — sat only inside the disposable selector), starving the matcher's stable-identity field exactly where unlabeled radio groups are hardest to disambiguate. Text/password/email inputs are deliberately excluded — their `value` is transient typed content, not a label.
- fix(fingerprinting): capture now fires for **iframe-nested elements**. The frame-walk fallback in `getCenterInFrame` resolved iframe elements but never fingerprinted them — the top-frame capture wrapper (`getElementCenter` → `resolveWithHealing`) evals against the top frame, so child-frame elements were invisible to the dataset. Added a thin `ctx.captureFingerprintInContext(contextId, selector)` hook (called from `frames.ts`, wired in `tools.ts`, delegating to the gated `captureInContext` helper in the experiment module) that captures bound to the child frame's execution context.
- feat(fingerprinting): **iframe self-healing**. When a selector misses in the top frame *and* the iframe selector walk also misses, `getCenterInFrame` now scores the stored fingerprint against each child frame's DOM (`getChildFrameContexts` enumerates isolated worlds; the gated `ctx.healFingerprintInContext` hook → `healInContext` scores + gates per frame), picks the highest-scoring gate-passing hit, and translates its iframe-local center to top-frame coordinates via the shared `accumulateFrameOffset` walk. Same 0.6/0.10 gate as the top-frame path; falls through to the original "Element not found" error when no frame clears the gate. Telemetry note: an iframe heal is preceded by a top-frame `escalated` event (the top-frame `resolveWithHealing` escalates before the iframe walk runs), so `outcome: "healed"` from an iframe supersedes the immediately-preceding `escalated` for the same selector — net them when computing heal rate.
- **CLI: `supersurf profiles ls|open <name>`** — human-facing profile management. `ls` lists profiles with running/connected state; `open` launches a profile's Chromium as **user-owned**: it survives agent session teardown, daemon shutdown/idle-timeout, and the startup orphan sweep (close the window to end it). New daemon IPC method `profiles.launch`.
- **Daemon: idle timeout suppressed while a user-owned browser is running** — prevents the daemon from idling out underneath a human-opened profile browser; timer re-arms when the browser closes.
- **Fix: `profiles.connect` is now pool-aware** — an agent attaching to a profile whose browser is already connected (e.g. CLI-launched) no longer double-spawns Chromium onto the same user-data-dir.
- **Fix: dispatcher help text no longer suggests `npx supersurf@latest`** (a squatted npm name that isn't us) — corrected to `npx supersurf-mcp@latest`.

## 3.0.2 — 2026-06-07

- chore: delisted the `supersurf creds` subcommand (keychain storage + CLI remain in the tree but unrouted) until the keychain is wired into `secure_fill`; `secure_fill` now carries a soft pre-deprecation notice and stays fully functional
- docs: swept stale claims out of `README.md`, `server/README.md`, `daemon/README.md`, and `CLAUDE.md` after a cross-file audit. Removed the retired `experimental_features` tool and the nonexistent `browser_reload_extensions` tool from the tool tables; moved `secure_eval` (graduated v1.11.0) and `profiles` (graduated v2.1.0) out of the "experimental" sections and documented `secure_eval` as default-on with the `--disable-secure-eval` opt-out; pointed the npm badge at `supersurf-mcp` instead of the squatted `supersurf`; corrected the daemon README's `session_ack` payload (no `capabilities.profiles` field) and auto-spawn description (bundled local resolution, not `npx @latest`); fixed `tools/frames.ts` → `tools/lib/frames.ts` and the membrane test path in CLAUDE.md, added the `shared/config` + `shared/keychain` submodules and six unlisted server test files, and added a prominent npm-name-squat callout pointing to the `supersurf-npm-namesquat-dispute-2026-06-07` tracker

## 3.0.1 — 2026-06-06

- **BREAKING: feat**: v3 repackaging — `supersurf-mcp` (server) and `supersurf-daemon` (daemon) ship the new bin dispatcher (`supersurf mcp` / `supersurf daemon` / `supersurf creds` subcommands), the version-mismatch guard, and explicit-`mcp` behavior: a bare `supersurf` (or `--help`/`-h`) prints usage to stdout and exits 0 instead of silently starting the stdio server, and an unrecognized command prints usage to stderr and exits 1. The old bin aliases (`supersurf-mcp`, `supersurf-daemon`) still work with a stderr deprecation notice. **The originally-planned merge into a single `supersurf` package is deferred** — the bare `supersurf` name is squatted on npm by a stale `0.0.1` placeholder (dead website, last touched ~10 months ago); an ownership dispute is in progress. Until it resolves, the two ship separately under the names we own: `supersurf-mcp` depends on `supersurf-daemon`, both versioned in lockstep, and the daemon is **not** bundled into the server. Install with `npx supersurf-mcp@latest mcp`
- **BREAKING: feat**: a server now refuses to attach to a daemon of a mismatched version. On `connect`, if the running daemon's version (sent on the `session_ack` handshake) differs from the server — or predates the version field — `connect` returns a `version_mismatch` error and tells the operator to restart the daemon. Prevents a fresh server from silently driving a stale daemon over the shared socket (protocol skew). Normal installs match (server + daemon version-locked), so this only fires when a stale daemon from a prior version is still running
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
