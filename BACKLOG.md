---
next_id: 12
---

# Backlog

**`next_id` is a lock, not bookkeeping.** Claim a number by bumping it in the same commit that
adds the item. Two branches appending items to the end of this file merge *cleanly* — git sees
appends at different offsets, raises no conflict, and you end up with two `## 7.` sections and no
error anywhere. Both branches bumping the same single line forces a merge conflict instead, which
is the entire point. Do not add further frontmatter fields: anything without a consumer goes stale.

Work that has been accepted but not yet done. Features, bugs, chores and test gaps all belong
here — tag the title. Ordered by when it was raised, not by priority. `CHANGELOG.md` is what
shipped (live code only); this is what hasn't. Stickynotes hold long-form design detail behind a
one-line pointer.

**Rules**
- **Add:** append `## N. \`tag\` — title`, bump `next_id` in the same commit. Tags: `feat`,
  `bug`, `chore`, `test-gap`.
- **Shape:** `**Status:**` (`TODO` | `BLOCKED — why` | `DONE — date, commit`), then
  Want / Today / Touch points, **Open questions** (each tagged `[factual]` — an agent can answer
  it by reading code or logs — or `[decision]` — belongs to the owner, do not dispatch; untagged
  defaults to `[decision]`), and **Done when** (the acceptance line).
- **Done:** whoever lands the work sets `**Status:** DONE — <date>, <commit>` in the same PR,
  before reporting complete. Leave the item text in place.
- **Prune:** at `version.bump`, delete every `DONE` item — the changelog entry and the git tag
  already record it. This file stays short.
- **Won't do:** closed decisions live in the section at the bottom so they do not get re-opened.

---

## 1. `feat` — Native browser backend (own browser)

**Status:** TODO — in progress as a separate personal project.

**Want:** a from-scratch browser engine, built as the owner's standalone learning venture, that
matures into SuperSurf's second backend. **Not a Chromium fork** — forking was rejected hard
(perpetual rebase treadmill, worse once Chrome moves to ~2-week stables around Chrome 153).

**Today:** Chromium + extension only. Integration path already designed: no merge event. The
engine implements the daemon's existing command surface behind the `IExtensionTransport` seam;
`profiles.connect` picks `chrome` or `native`; ships as a default-off experiment. Existing users
unaffected. Payoff: owning the browser process deletes the ~80% of extension surface that exists
only to compensate for not owning it (MV3 keepalive, storage handshake, matchmaker poaching
prevention). The one real rebuild is isolated-world injection.

**Touch points:** `daemon/src/ipc.ts` (`profiles.connect`), `server/src/daemon-client.ts`
(`IExtensionTransport`), experiment registry.

**Open questions:**
- `[decision]` Readiness criteria before the first default-off experiment lands — see the
  "Brainstorming: Browser Talks" session (2026-08-01).

**Done when:** `profiles.connect` accepts `backend: 'native'` behind an experiment and a smoke
session (connect → navigate → snapshot → click) passes on the native engine.

Market note: Cloudflare's Kitesurf (2026-08-06) validates the agent-browser space but plays the
opposite lane — datacenter V8 isolates vs. our local real-profile posture.

---

## 2. `feat` — Playbooks: route scoping + heal every selector verb

**Status:** TODO.

**Want:** (a) route templating so a handle named on `/jobs/1234` resolves on `/jobs/5678`;
(b) healing for every selector-resolving verb, not just `click`/`hover`/`drag`.

**Today:** verb + order model shipped (`## Unreleased`): `playbooks` MCP tool (`history` /
`create` / `run`), `supersurf playbook` CLI, replay of every trail-recorded tool. Healing is
verb-limited — a `type` / `select_option` / `file_upload` step fails without a heal attempt.
Route scoping not started; it was deferred until the verb model existed because the answer
depends on whether a playbook is workflow-bound or URL-bound.

**Touch points:** `server/src/tools/playbooks.ts`, `server/src/experimental/fingerprinting/`
(handle-resolve, store), `server/src/tools/interaction/registry.ts`.

**Open questions:**
- `[decision]` Workflow-bound vs URL-bound playbooks — owner-collaborative design, not an
  agent task. Stickynotes: `supersurf-playbooks-verb-order-model-2026-07`,
  `supersurf-playbooks-route-scoping-2026-07`.
- `[factual]` Which verbs resolve a selector today and can share the click heal path unchanged?

**Done when:** a playbook created on `/jobs/1234` runs on `/jobs/5678` without re-capture, and a
`type` step heals through a selector change in the same way `click` does.

---

## 3. `feat` — Smart mode

**Status:** TODO — concept only, no code.

**Want:** an opt-in layer for opinionated behavior. The harness core stays transparent — it
reports what the page did and lets the agent decide. Everything that "just handles" something for
the agent lives here, behind a flag.

**Today:** parked behaviors: auto-answering native dialogs (hold-timeout auto-dismiss,
auto-accept known-safe confirms, auto-dismiss `beforeunload` on intentional navigation), click
auto-retry and input-method escalation, auto kill+rebind of a wedged daemon port. The legacy
auto-dismiss-`confirm()` default is an opinion living in the dumb layer and is slated to migrate
here.

**Touch points:** config leaf (`smart_mode`), `server/src/tools/interaction/`,
`extension/src/handlers/dialogs.ts`, daemon port handling.

**Open questions:**
- `[decision]` Flag shape — one `smart_mode: true` or per-behavior leaves? Stickynote:
  `smart-mode-roadmap-2026-06`.

**Done when:** a `smart_mode` config leaf exists, default off, and the legacy auto-dismiss
`confirm()` behavior lives behind it.

---

## 4. `feat` — Telemetry across all event sources

**Status:** TODO.

**Want:** log practically everything the harness touches, not just calls that reached dispatch.

**Today:** the usage-metrics trail records calls that already reached dispatch — rejected calls,
unvalidated params, selector resolution attempts and cross-action state are invisible. The trail
answers "what did agents do" but not "what did agents try and fail at." See also #10 (the
existing trail has its own gaps).

**Touch points:** `server/src/usage-metrics-logger.ts`, `server/src/tools.ts`,
`server/src/recorder/action-recorder.ts`, schema validation path.

**Open questions:**
- `[decision]` Same file or a second trail? Stickynote:
  `supersurf-logging-surface-expansion-2026-08`.

**Done when:** a schema-rejected tool call appears in the trail with `result: 'error'` and the
validation message.

---

## 5. `chore` — `creds` subcommand: wire it or delete it

**Status:** TODO — needs a call.

**Want:** `secure_fill` pulls from the OS keychain instead of `.env`.

**Today:** the keychain-backed `creds` CLI is built and tested (`server/tests/bin-creds.test.ts`)
but delisted from the bin dispatcher — it routes to help.

**Touch points:** `server/src/bin/dispatcher.ts`, `server/src/bin/creds.ts`,
`shared/keychain/`, `extension/src/secure-fill.ts`.

**Open questions:**
- `[decision]` Finish wiring it, or delete the code and the `shared/keychain/` backends?

**Done when:** either `supersurf creds` is routed and documented in `CLAUDE.md`, or the code,
tests and docs references are gone.

---

## 6. `feat` — Dataset-driven mouse profiles

**Status:** BLOCKED — BeCAPTCHA dataset access.

**Want:** replace hand-tuned Balabit constants in mouse humanization with profiles trained on real
human movement data.

**Today:** the `DistributionProfile` interface
(`server/src/experimental/mouse-humanization/profile.ts`) already accepts them.

**Done when:** a trained profile loads through `DistributionProfile` and the humanization tests
pass against it.

---

## 7. `bug` — Connection lifecycle is the top error source

**Status:** TODO.

**Want:** `connect` / `browser_tabs` / `browser_navigate` fail fast and recover without a fresh
session when the daemon or extension is not there.

**Today:** usage audit 2026-08-21 (`.claude/skills/usage-data-audit/reports/2026-08-21-sweep.md`):
~22% of all errors in the last 3 months are connection-lifecycle. `connect` 17.3% err with a
**90 s p95**; "Extension not connected" ×148 (tabs 114, navigate 32); "Not connected to daemon"
×81; "Daemon Version Mismatch" ×49; "Connection Failed after N retries" ×43; "Request timeout:
getTabs" ×31. 69 sessions are dead probes (median 6 calls, 0 domains). The Aug error spike
(9.5% vs ~5% earlier) is this.

**Touch points:** `server/src/backend/handlers.ts` (connect), `server/src/daemon-spawn.ts`,
`server/src/daemon-client.ts`, `daemon/src/ipc.ts`, `server/src/backend/status.ts`.

**Open questions:**
- `[factual]` What does the 90 s p95 wait on — daemon spawn poll, extension match, or version
  mismatch retry loop?
- `[factual]` Why does "Daemon Version Mismatch" recur across sessions instead of being fixed by
  one restart?
- `[decision]` Auto-restart a mismatched daemon (smart-mode territory, #3) or only surface a
  one-shot fix in the status header?

**Done when:** `connect` p95 < 15 s in the next audit window, and a "Daemon Version Mismatch"
response tells the agent the exact command to run.

---

## 8. `feat` — Batch extraction: selector list → JSON

**Status:** TODO.

**Want:** one purpose-built call that returns several fields/elements as structured JSON, so
agents stop reaching for `browser_evaluate` to batch-read a form or listing.

**Today:** 80.8% of `browser_evaluate` calls contain `querySelector`, 61.1% `textContent` /
`innerText`, only 3% `.click()` — evaluate is a batch-read tool in practice. The
`eval-queryselector-to-lookup` tip fired 1,438× with 4.9% follow-through,
`eval-innerhtml-to-extract` 126× at 0.8%; 55% of tip-seeing sessions got the same tip 3+ times.
`browser_lookup` is single-element-by-text; `browser_extract_content` is markdown-only. Typical
snippet: `Array.from(document.querySelectorAll('textarea')).map(t => ({id: t.id, name: ...`.

**Touch points:** `server/src/tools/content.ts` (lookup / extract), `server/src/tools/schemas.ts`,
`server/src/tips.ts` (retarget the two tips), `server/src/tools/lib/frames.ts`.

**Open questions:**
- `[decision]` New mode on `browser_lookup` (`selectors: [...]` → array) or on
  `browser_extract_content` (`fields: {name: selector}` → object)?
- `[factual]` What attribute set covers the audited snippets (value, id, name, text, href,
  checked, options)?

**Done when:** the tool ships, both tips point at it, and the next audit shows
`eval-queryselector-to-lookup` volume down by half.

---

## 9. `bug` — `select_custom`, `file_upload`, `browser_storage` fail

**Status:** TODO.

**Want:** three broken surfaces either work or are removed.

**Today (audit 2026-08-21):** `browser_interact` `select_custom` 71.4% err (n=14);
`file_upload` 19.3% err (n=114); `browser_storage` **100% err** (n=9);
`browser_handle_dialog` 58% err (n=12, p95 60 s).

**Touch points:** `server/src/tools/interaction/select-option.ts`,
`server/src/tools/interaction/file-upload.ts`, `server/src/experimental/storage-inspection.ts`,
`server/src/tools/misc.ts` (dialog).

**Open questions:**
- `[factual]` Is `select_custom` 71% a real defect or 2–3 pathological pages? Pull the 14 entries.
- `[factual]` What error does `browser_storage` return on every call?
- `[decision]` Keep `browser_storage` (experiment) or drop it?

**Done when:** each of the four has a regression test for its audited failure mode, or is
removed from `schemas.ts` with a changelog line.

---

## 10. `chore` — Usage-metrics trail: `client`, telemetry tagging, `run_id`

**Status:** TODO.

**Want:** the trail is segmentable by MCP client, tool distributions do not need manual
exclusion of recorder rows, and a reused `session_id` does not merge unrelated runs.

**Today:** `client` is declared in `MetricsEntry` (`server/src/usage-metrics-logger.ts:54`) and
written by nobody — 0/35,495 entries. Recorder rows (`action` 6,527, `fingerprint` 3,339,
`handle` 548 — 29% of entries) share the `tool` column with agent calls. 26 `session_id`s were
reused across days (e.g. `job-search-operator`, 52 files, May–Aug), so per-session duration and
repeat-offender math is noise for them.

**Touch points:** `server/src/usage-metrics-logger.ts`, `server/src/tools.ts` (write sites),
`server/src/recorder/action-recorder.ts`, `server/src/experimental/fingerprinting/` (telemetry),
`.claude/skills/usage-data-audit/SKILL.md` (schema notes).

**Open questions:**
- `[factual]` Where is client info available at write time — `BrowserBridge.clientInfo`?
- `[decision]` `kind: 'telemetry'` field vs a `telemetry.` tool-name prefix?

**Done when:** new entries carry `client`, recorder rows are distinguishable by a field, every
entry carries a per-process `run_id`, and the audit skill's schema section is updated.

---

## 11. `chore` — Retire or defend zero-use tools

**Status:** TODO.

**Want:** no MCP tool ships that nobody calls.

**Today:** 0 calls in 3 months / 35,495: `reload_mcp`, `browser_performance_metrics`. Near-zero:
`browser_pdf_save` 3, `browser_drag` 2, `browser_list_extensions` 2,
`browser_verify_element_visible` 1. (`playbooks` 5 — shipped in 3.3.0, too early to judge.)

**Touch points:** `server/src/tools/schemas.ts`, `server/src/backend/schemas.ts`,
`server/src/tools/misc.ts`.

**Open questions:**
- `[decision]` Per tool: delete, or keep with a stated reason (e.g. `pdf_save` is a
  capability users expect even if agents rarely use it)?

**Done when:** each listed tool is either removed (changelog line) or has a one-line "kept
because" note here, and the item is marked DONE.

---

## Won't do

- **Windows support.** macOS and Linux only. Not planned.
- **Single-package `supersurf` merge.** Cancelled permanently — npm refused the name-squat
  dispute on 2026-06-09 and the trademark-only path they offered isn't worth it for a FOSS name.
  Ships as `supersurf-mcp` + `supersurf-daemon` forever. Do not reopen.
  Stickynote: `supersurf-npm-namesquat-dispute-2026-06-07`
