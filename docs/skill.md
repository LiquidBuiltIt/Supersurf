---
name: supersurf
description: Drive a real Chrome browser through the SuperSurf MCP server — navigate, read pages, interact, fill forms, and record/replay playbooks. Use when a task needs a live browser session.
---

# SuperSurf — Agent Skill Guide

> You control a real Chrome browser. Real cookies, real sessions, real history. You are not using a headless browser or a simulator — you are operating a full Chrome instance with a human's profile.

> **Install as a Claude Code skill:** save this file as `~/.claude/skills/supersurf/SKILL.md` (or `.claude/skills/supersurf/SKILL.md` in a project) and it loads as `/supersurf`.

---

## Setup

If SuperSurf isn't installed yet, help the user get set up:

**1. Install the Chrome extension**

[Install from Chrome Web Store](https://chromewebstore.google.com/detail/falcdhojcinkkbffgnipppcdoaehgpek) — or load unpacked from source via `chrome://extensions` → Developer mode → Load unpacked.

**2. Add the MCP server to your client**

```bash
# Claude Code
claude mcp add supersurf -- npx supersurf-mcp@latest mcp

# Claude Desktop / other MCP clients — add to config:
{
  "mcpServers": {
    "supersurf": {
      "command": "npx",
      "args": ["supersurf-mcp@latest", "mcp"]
    }
  }
}
```

**3. Open Chrome and enable the extension** — click the SuperSurf icon in the toolbar and hit "Enable". The extension connects to the local daemon automatically.

That's it. You're ready to use the tools below.

---

## Quick Start

```
1. connect client_id='my-task'
2. browser_tabs action='list'
3. browser_tabs action='attach' index=0    (or tabId=123)
4. browser_snapshot                         (read the page)
5. Do your work
6. disconnect
```

You MUST connect before doing anything. You MUST attach to a tab before using any browser tool. Every response includes a status line showing your connection state, attached tab, and detected tech stack.

---

## Core Workflow

### Reading Pages

**Use `browser_snapshot` first, not screenshots.** Snapshots return the accessibility tree as structured text — faster, cheaper, and more actionable than an image. Use screenshots only when you need visual confirmation.

```
browser_snapshot                              → structured DOM tree
browser_lookup text='Sign In'                 → find elements by visible text, get selectors
browser_extract_content mode='auto'           → clean markdown of main content
browser_extract_content mode='selector'       → target specific section
  selector='#results'
```

`browser_lookup` is your best friend for finding the right selector before clicking. It returns selectors, visibility, position, and dimensions.

### Interacting with Pages

`browser_interact` takes an array of actions executed in sequence:

```
browser_interact actions=[
  { "type": "click", "selector": "#email", "name": "email_input", "purpose": "focus email field" },
  { "type": "type", "selector": "#email", "text": "user@example.com", "name": "email_input", "purpose": "enter email" },
  { "type": "click", "selector": "button[type=submit]", "name": "submit_button", "purpose": "submit login form" }
]
```

**Available actions:** `click`, `type`, `clear`, `press_key`, `hover`, `mouse_move`, `mouse_click`, `scroll_to`, `scroll_by`, `scroll_into_view`, `wait`, `select_option`, `select_custom`, `file_upload`, `force_pseudo_state`

**Key parameters:**
- `onError`: `'stop'` (default) or `'ignore'` — controls whether the sequence halts on failure
- `screenshot`: `true` to capture after all actions complete
- `name` / `purpose`: for element-targeting actions (click/type/clear/hover/select_option/select_custom/file_upload) — a short snake_case name and a one-line reason for the element. Not schema-enforced, but skip it and the element can't later be resolved by name or replayed cleanly — see Playbooks below.

**Keyboard keys for `press_key`:** Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Space, Home, End, PageUp, PageDown

### Native Dialogs

`alert`/`confirm`/`prompt`/`beforeunload` are held open, not auto-answered. When one fires, the triggering tool's response carries a `_dialogs` warning, and further page-touching calls are blocked until you resolve it:

```
browser_handle_dialog action='view'                → read the held dialog
browser_handle_dialog action='accept'               → click OK (pass text= for a prompt)
browser_handle_dialog action='dismiss'              → click Cancel
```

### Navigating

```
browser_navigate action='url' url='https://example.com'
browser_navigate action='back'
browser_navigate action='forward'
browser_navigate action='reload'
```

Add `screenshot=true` to capture after navigation.

### Managing Tabs

```
browser_tabs action='list'                    → see all tabs with IDs, URLs, tech stacks
browser_tabs action='new' url='https://...'   → open new tab (auto-attaches)
browser_tabs action='attach' tabId=123        → attach by ID (preferred over index)
browser_tabs action='attach' index=2          → attach by index
browser_tabs action='close'                   → close attached tab
browser_tabs action='close' index=3           → close specific tab
```

**Prefer `tabId` over `index`** — tab IDs are stable, indexes shift when tabs open/close. Use `list` first to get IDs.

Popup windows (like OAuth flows) are visible and attachable. They show `windowType: 'popup'` in the tab list.

---

## Forms & Credentials

### Filling Forms

For multiple fields at once:
```
browser_fill_form fields=[
  { "selector": "#name", "value": "John" },
  { "selector": "#email", "value": "john@example.com" },
  { "selector": "#country", "value": "US" }
]
```

Handles inputs, textareas, selects, checkboxes, and radio buttons. Fires proper events for React/Vue/Angular compatibility.

### Credentials (secure_fill)

**Never type passwords directly.** Use `secure_fill` — credentials are stored as environment variables on the server and typed char-by-char with randomized delays. You never see the actual values.

```
secure_fill action='list'                     → see available credential names
secure_fill action='fill'                     → type credential into field
  selector='#password'
  credential_env='MY_PASSWORD'
```

**Note:** `secure_fill` carries a soft pre-deprecation notice — a keychain-backed credential store is planned to replace it eventually — but it remains fully functional and is the only working credential path today.

---

## Best Practices

### Do This

1. **Snapshot before acting.** Always read the page state before clicking or typing. Pages change — don't assume.
2. **Lookup before clicking.** Use `browser_lookup` to find the right selector. Don't guess selectors.
3. **Use tabId, not index.** Tab indexes shift. Tab IDs are stable identifiers.
4. **Batch interactions.** Send multiple actions in one `browser_interact` call instead of separate calls. Reduces round-trips.
5. **Use `extract_content` for reading.** When you need page text (articles, search results, tables), use `browser_extract_content` with `mode='auto'`. It returns clean markdown.
6. **Check the status line.** Every response tells you your current tab, URL, and detected framework. Use this context.
7. **Record playbooks for repeated flows.** Once a flow works, freeze it into a playbook instead of re-deriving selectors on every run — see Playbooks.

### Don't Do This

1. **Don't screenshot to read text.** Screenshots cost tokens and can't be searched. Use `snapshot` or `extract_content`.
2. **Don't hardcode selectors.** Pages change. Use `browser_lookup` to find current selectors dynamically.
3. **Don't forget to attach.** Every browser tool requires an attached tab. If you get an error about no tab, call `browser_tabs action='attach'`.
4. **Don't type credentials directly.** Always use `secure_fill`. If the credential isn't available, ask the user to set the environment variable.
5. **Don't wait with fixed sleeps.** Use `browser_interact` with `{ "type": "wait", "selector": "#element" }` to wait for specific elements. Enable the `smart_waiting` experiment (`~/.supersurf/config.json`) for adaptive waits on navigation.
6. **Don't fight popup windows.** If a Google OAuth popup appears, it shows in `browser_tabs action='list'`. Attach to it by `tabId`, interact with it, then switch back.

---

## Experimental Features

Experiments are toggled in `~/.supersurf/config.json` under the `experiments` key, then require a daemon restart to take effect — there is no live in-session toggle (the old `experimental_features` MCP tool was retired in v2.0.0):

```json
{
  "experiments": {
    "page_diffing": true,
    "smart_waiting": true,
    "mouse_humanization": true,
    "storage_inspection": true,
    "fingerprinting": true
  }
}
```

```
supersurf daemon restart
```

| Feature | What It Does | When To Use |
|---------|-------------|-------------|
| `page_diffing` | Returns what changed in the DOM after an interaction (added/removed text, element counts), including inside open shadow roots | When you need to verify an action had the expected effect without re-reading the full page |
| `smart_waiting` | Replaces fixed delays with adaptive DOM stability + network idle detection | Always — reduces wasted time on fast pages, prevents acting too early on slow ones |
| `mouse_humanization` | Generates human-like Bezier cursor paths with overshoot and idle drift | When interacting with sites that have bot detection (CAPTCHAs, anti-automation) |
| `storage_inspection` | Unlocks `browser_storage` tool for localStorage/sessionStorage read/write | When you need to inspect or modify client-side storage |
| `fingerprinting` | Lets named elements (`name`/`purpose` on `browser_interact`) be resolved by name later, heals selectors when a page changes, and gates `playbooks` `create`/`run` | Before you need a flow to survive selector churn, or before saving a playbook |

`secure_eval` is separate from the experiments above — it's a security setting (`security.secure_eval`, default `true`), not an opt-in experiment. It AST-analyzes `browser_evaluate` code and blocks dangerous patterns by default. Opt out only via `SUPERSURF_DISABLE_SECURE_EVAL=1` in the server environment — this defeats RCE protection.

---

## Profiles (Isolated Browser Sessions)

Profiles give you a completely isolated Chromium instance — separate cookies, sessions, history, extensions. Useful for running multiple accounts or clean-slate automation.

```
profile_list                                  → see existing profiles
profile_create name='my-project'              → create new profile
connect client_id='task-1' profile='my-project'  → connect using profile
profile_delete name='old-profile'             → delete profile and all data
```

When you connect with a profile, SuperSurf launches a dedicated Chromium instance with its own user data directory. The profile persists between sessions — cookies and logins survive disconnects.

**Profile names:** lowercase alphanumeric and hyphens only, max 32 characters. `profile_create` also accepts an optional `experiments` object to pre-enable experiment defaults for that profile (e.g. `{ "fingerprinting": true }`).

---

## Playbooks

Playbooks turn a browsing run you already did into a replayable artifact. Every tool call in a session gets a numeric id, shown as an `#NNNN` prefix on the result; `playbooks` lets you cite those ids to freeze a flow, then replay it later without re-deriving selectors from scratch.

`create` and `run` require the `fingerprinting` experiment (off by default — see Experimental Features above). Without it a saved playbook's selectors can't heal, so it would break on the first page change. `history` works regardless — it only reports what already happened.

```
playbooks action='history'                     → list this session's numbered actions
playbooks action='create' name='login_flow'     → freeze cited ids into a playbook
  purpose='Log into app.example.com'
  steps=[5211, 5212, 5214]
playbooks action='run' name='login_flow'        → replay a saved playbook
```

**Worked example:**
1. Do the flow normally — navigate, snapshot, click, type, submit. Each action returns an id, e.g. `#5211 ✓ Clicked #email`.
2. `playbooks action='history'` to see the numbered list, and pick the ids that make up the flow — drop any that failed or were just exploring.
3. `playbooks action='create' name='login_flow' purpose='...' steps=[5211, 5212, 5214]`.
4. Later: `playbooks action='run' name='login_flow'`. Step 1's recorded URL becomes the run's start point — SuperSurf auto-navigates there first, unless step 1 is itself a navigate or a `browser_tabs action='new'` (in which case navigating first would either double-load the page or fail with no tab attached yet).

`run` replays every step type, not only `browser_interact` — a frozen `browser_extract_content` or `browser_navigate` step re-issues with its original params, and its output is appended to the run result. Selector healing covers every selector-resolving `browser_interact` verb (`click`, `hover`, `drag`, `type`, `clear`, `select_option`, `select_custom`, `scroll_to`, `scroll_by`, `scroll_into_view`, `file_upload`) plus `browser_fill_form` fields; `force_pseudo_state` and `wait` fail outright if their selector has drifted (`wait` deliberately waits for the original selector, not a look-alike). A run stops at the first failure and reports how far it got.

**`run` works without an active session.** With no connection, `playbooks action='run'` connects implicitly, then runs the playbook — the response says so, e.g. `Connected implicitly to run playbook.` The target profile resolves in order: an explicit `profile` param, then the playbook's own bound profile (set by `create` when the recording session was profile-bound), then no profile (plain connect). Add `detach=true` to disconnect again after the run — success or failure — leaving no session behind; default is `false`, so the session stays active for further calls.

```
playbooks action='run' name='login_flow' profile='my-project'   → implicit connect, pinned profile
playbooks action='run' name='login_flow' detach=true             → implicit connect, disconnect after
```

If a session is already active, `run` uses it as-is — unless the resolved profile (from the `profile` param or the playbook's own field) differs from the session's bound profile, in which case `run` refuses with an error rather than silently re-binding. Disconnect and reconnect with the right profile, or drop `profile` to run on the current session.

Playbooks live one file per playbook at `~/.supersurf/playbooks/<name>.json`. Everything beyond record/replay is CLI-only — the MCP tool deliberately can't list, edit, or delete:

```
supersurf playbook ls                           → list saved playbooks
supersurf playbook show login_flow              → print its steps
supersurf playbook edit login_flow --drop 3      → remove step 3
supersurf playbook edit login_flow               → open it in $EDITOR for a free-form edit
supersurf playbook rm login_flow                 → delete it
supersurf playbook export login_flow out.json   → write it to a file
supersurf playbook import out.json               → read it from a file
```

`supersurf playbook run <name> [--profile <p>] [--json]` replays a playbook without an MCP client — it drives the same `connect` → `playbooks run` → `disconnect` sequence in-process, over the daemon, so it's the same runner the MCP tool uses. `--profile` picks a managed profile to connect to (falling back to the playbook's own `profile` field if it has one); `--json` prints `{name, success, output}` instead of the run trail. Exit code is 0 only when every step succeeded; a failed step, a missing playbook, or a failed connect all exit 1, and the browser session is always disconnected on the way out.

---

## Network & Debugging

### Network Traffic
```
browser_network_requests action='list'                    → recent requests
browser_network_requests action='list' urlPattern='api'   → filter by URL
browser_network_requests action='list' method='POST'      → filter by method
browser_network_requests action='details' requestId='...' → full request/response
browser_network_requests action='replay' requestId='...'  → re-send a request
browser_network_requests action='clear'                   → clear the captured log
```

### Console Messages
```
browser_console_messages                      → all console output
browser_console_messages level='error'        → errors only
browser_console_messages text='warning'       → filter by text
```

### JavaScript Execution
```
browser_evaluate expression='document.title' purpose='read the page title'
browser_evaluate function='() => document.querySelectorAll("a").length' purpose='count links'
```

`purpose` is required — explain why a dedicated tool (`browser_lookup`, `browser_extract_content`, `browser_interact`, `browser_fill_form`, `browser_navigate`, `browser_get_element_styles`, `browser_storage`) won't do. `browser_evaluate` is for read-only computation only; `secure_eval` blocks writes, storage access, navigation, and other dangerous patterns via AST analysis. If your code is blocked, use the dedicated tool instead of working around it.

### Performance
```
browser_performance_metrics                   → Core Web Vitals (FCP, LCP, CLS, TTFB)
```

---

## CSS Inspection

```
browser_get_element_styles selector='#header'
browser_get_element_styles selector='button' property='background-color'
browser_get_element_styles selector='a' pseudoState=['hover']
```

Returns matched CSS rules with source file/line, computed values, and which rules are applied vs overridden.

---

## Screenshots & PDFs

```
browser_take_screenshot                                   → viewport JPEG (default; inline image)
browser_take_screenshot fullPage=true                     → entire page
browser_take_screenshot selector='#chart'                 → crop to element
browser_take_screenshot highlightClickables=true          → outline clickable elements
browser_take_screenshot path='/tmp/screenshot.png'        → save to file

When `path` is omitted, output follows `screenshot.omit_path` in `~/.supersurf/config.json`:
`inline` (default), `path` (temp file under OS tmpdir, text only), or `both`. Env override: `SUPERSURF_SCREENSHOT_OMIT_PATH`.
browser_pdf_save path='/tmp/page.pdf'                     → export as PDF
```

Screenshots are auto-downscaled to prevent token bloat. Save to file to preserve full resolution.

---

## Downloads

```
browser_download url='https://example.com/file.zip'
browser_download url='https://...' filename='report.pdf'
browser_download url='https://...' destination='/tmp/downloads/'
```

Files download through the browser (real cookies/auth apply). Optional `destination` moves the file from Chrome's Downloads folder to your specified path.

---

## Other Browser Tools

```
browser_drag fromSelector='#item' toSelector='#dropzone'    → drag one element onto another
browser_window action='resize' width=1280 height=800        → resize/close/minimize/maximize the window
browser_verify_text_visible text='Welcome back'              → assert text is visible on the page
browser_verify_element_visible selector='#dashboard'          → assert an element is visible
browser_list_extensions                                        → list installed Chrome extensions
```

---

## Common Patterns

### Login Flow
```
connect client_id='login-task'
browser_tabs action='list'
browser_tabs action='attach' index=0
browser_navigate action='url' url='https://app.example.com/login'
browser_snapshot
browser_lookup text='Email'
browser_interact actions=[
  { "type": "click", "selector": "#email", "name": "email_input", "purpose": "focus email field" },
  { "type": "type", "selector": "#email", "text": "user@example.com", "name": "email_input", "purpose": "enter email" }
]
secure_fill action='fill' selector='#password' credential_env='APP_PASSWORD'
browser_interact actions=[{ "type": "click", "selector": "button[type=submit]", "name": "submit_button", "purpose": "submit login form" }]
browser_snapshot
```

### Handling OAuth Popups
```
browser_tabs action='list'                    → spot the popup (windowType: 'popup')
browser_tabs action='attach' tabId=456        → attach to popup
browser_snapshot                              → read the OAuth form
browser_interact actions=[...]                → interact with it
browser_tabs action='attach' tabId=123        → switch back to main tab
```

### Scraping with Pagination
```
browser_extract_content mode='auto'           → get first page content
browser_lookup text='Next'                    → find next button
browser_interact actions=[{ "type": "click", "selector": ".next-page", "name": "next_page_button", "purpose": "go to next results page" }]
browser_extract_content mode='auto'           → get next page content
```

### Monitoring Network Calls
```
browser_navigate action='url' url='https://app.example.com'
browser_network_requests action='list' urlPattern='/api/' method='GET'
browser_network_requests action='details' requestId='req-42'
```

---

## Status Line Reference

Every tool response starts with a status line:

```
✅ v3.3.0 | 🌐 Chrome | 📄 Tab 0: https://example.com | 🔧 React + Tailwind
```

| Badge | Meaning |
|-------|---------|
| ✅ / 🔴 | Connected / Disconnected |
| 🌐 | Browser name |
| 📄 | Attached tab index + URL |
| ⚠️ No tab attached | No tab attached (attach one first) |
| 🔧 | Detected tech stack (framework, library, CSS) |
| ⚠️ Obfuscated CSS | Class names look machine-generated — style selectors may be unstable |
| 🕵️ | Stealth mode active |

When disconnected, the header reads `🔴 vX.Y.Z | Disabled`, plus a one-line reason if the last `connect` attempt failed (e.g. a port conflict). If `~/.supersurf/config.json` changed since the daemon started, a one-shot warning line precedes the header until you restart the daemon (`supersurf daemon restart`).

---

## Architecture (Need-to-Know)

- You talk to an MCP server over stdio. The server talks to a daemon over a Unix socket. The daemon talks to a Chrome extension over WebSocket. The extension controls Chrome.
- The extension runs in Chrome's isolated world — page JavaScript cannot detect it.
- CDP is only used for screenshots, network interception, and PDF generation. All DOM interaction goes through content scripts.
- The daemon persists across sessions. Managed Chromium quits on disconnect by default; enable extension Settings "Keep browser after session ends" to keep the window open. Profile cookies/logins always persist on disk. Daemon idle timeout or shutdown can still quit daemon-owned browsers.
- Every tool call is logged to the usage-metrics trail at `~/.supersurf/logs/sessions/`, gated by `logging.usage_metrics` in config (on by default for new installs).
