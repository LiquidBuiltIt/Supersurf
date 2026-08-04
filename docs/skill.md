# SuperSurf — Agent Skill Guide

> You control a real Chrome browser. Real cookies, real sessions, real history. You are not using a headless browser or a simulator — you are operating a full Chrome instance with a human's profile.

---

## Setup

If SuperSurf isn't installed yet, help the user get set up:

**1. Install the Chrome extension**

[Install from Chrome Web Store](https://chromewebstore.google.com/detail/falcdhojcinkkbffgnipppcdoaehgpek) — or load unpacked from source via `chrome://extensions` → Developer mode → Load unpacked.

**2. Add the MCP server to your client**

```bash
# Claude Code
claude mcp add supersurf -- npx supersurf-mcp@latest

# Claude Desktop / other MCP clients — add to config:
{
  "mcpServers": {
    "supersurf": {
      "command": "npx",
      "args": ["supersurf-mcp@latest"]
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
  { "type": "click", "selector": "#email" },
  { "type": "type", "selector": "#email", "text": "user@example.com" },
  { "type": "click", "selector": "button[type=submit]" }
]
```

**Available actions:** `click`, `type`, `clear`, `press_key`, `hover`, `mouse_move`, `mouse_click`, `scroll_to`, `scroll_by`, `scroll_into_view`, `wait`, `select_option`, `file_upload`, `force_pseudo_state`

**Key parameters:**
- `onError`: `'stop'` (default) or `'ignore'` — controls whether the sequence halts on failure
- `screenshot`: `true` to capture after all actions complete

**Keyboard keys for `press_key`:** Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Space, Home, End, PageUp, PageDown

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

---

## Best Practices

### Do This

1. **Snapshot before acting.** Always read the page state before clicking or typing. Pages change — don't assume.
2. **Lookup before clicking.** Use `browser_lookup` to find the right selector. Don't guess selectors.
3. **Use tabId, not index.** Tab indexes shift. Tab IDs are stable identifiers.
4. **Batch interactions.** Send multiple actions in one `browser_interact` call instead of separate calls. Reduces round-trips.
5. **Use `extract_content` for reading.** When you need page text (articles, search results, tables), use `browser_extract_content` with `mode='auto'`. It returns clean markdown.
6. **Check the status line.** Every response tells you your current tab, URL, and detected framework. Use this context.

### Don't Do This

1. **Don't screenshot to read text.** Screenshots cost tokens and can't be searched. Use `snapshot` or `extract_content`.
2. **Don't hardcode selectors.** Pages change. Use `browser_lookup` to find current selectors dynamically.
3. **Don't forget to attach.** Every browser tool requires an attached tab. If you get an error about no tab, call `browser_tabs action='attach'`.
4. **Don't type credentials directly.** Always use `secure_fill`. If the credential isn't available, ask the user to set the environment variable.
5. **Don't wait with fixed sleeps.** Use `browser_interact` with `{ "type": "wait", "selector": "#element" }` to wait for specific elements. Enable `smart_waiting` for navigation.
6. **Don't fight popup windows.** If a Google OAuth popup appears, it shows in `browser_tabs action='list'`. Attach to it by `tabId`, interact with it, then switch back.

---

## Experimental Features

Toggle with `experimental_features`. These enhance your capabilities:

| Feature | What It Does | When To Use |
|---------|-------------|-------------|
| `page_diffing` | Returns what changed in the DOM after an interaction (added/removed text, element counts) | When you need to verify an action had the expected effect without re-reading the full page |
| `smart_waiting` | Replaces fixed delays with adaptive DOM stability + network idle detection | Always — reduces wasted time on fast pages, prevents acting too early on slow ones |
| `mouse_humanization` | Generates human-like Bezier cursor paths with overshoot and idle drift | When interacting with sites that have bot detection (CAPTCHAs, anti-automation) |
| `storage_inspection` | Unlocks `browser_storage` tool for localStorage/sessionStorage read/write | When you need to inspect or modify client-side storage |
| `secure_eval` | 3-layer code analysis that blocks dangerous patterns in `browser_evaluate` | Enabled by default — keeps your JS execution safe |

```
experimental_features page_diffing=true smart_waiting=true mouse_humanization=true
```

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

**Profile names:** lowercase alphanumeric and hyphens only, max 32 characters.

---

## Network & Debugging

### Network Traffic
```
browser_network_requests action='list'                    → recent requests
browser_network_requests action='list' urlPattern='api'   → filter by URL
browser_network_requests action='list' method='POST'      → filter by method
browser_network_requests action='details' requestId='...' → full request/response
browser_network_requests action='replay' requestId='...'  → re-send a request
```

### Console Messages
```
browser_console_messages                      → all console output
browser_console_messages level='error'        → errors only
browser_console_messages text='warning'       → filter by text
```

### JavaScript Execution
```
browser_evaluate expression='document.title'
browser_evaluate function='() => { return document.querySelectorAll("a").length }'
```

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
browser_take_screenshot                                   → viewport JPEG (default)
browser_take_screenshot fullPage=true                     → entire page
browser_take_screenshot selector='#chart'                 → crop to element
browser_take_screenshot highlightClickables=true          → outline clickable elements
browser_take_screenshot path='/tmp/screenshot.png'        → save to file
browser_pdf_save path='/tmp/page.pdf'                     → export as PDF
```

Screenshots are auto-downscaled to prevent token bloat. Save to file to preserve full resolution.

---

## Downloads

```
browser_download url='https://example.com/file.zip'
browser_download url='https://...' destination='/tmp/downloads/'
```

Files download through the browser (real cookies/auth apply). Optional `destination` moves the file from Chrome's Downloads folder to your specified path.

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
  { "type": "click", "selector": "#email" },
  { "type": "type", "selector": "#email", "text": "user@example.com" }
]
secure_fill action='fill' selector='#password' credential_env='APP_PASSWORD'
browser_interact actions=[{ "type": "click", "selector": "button[type=submit]" }]
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
browser_interact actions=[{ "type": "click", "selector": ".next-page" }]
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
✅ v1.4.3 | 🌐 Chrome | 📄 Tab 0: https://example.com | 🔧 React + Tailwind
```

| Badge | Meaning |
|-------|---------|
| ✅ / 🔴 | Connected / Disconnected |
| 🌐 | Browser name |
| 📄 | Attached tab index + URL |
| ⚠️ | No tab attached (attach one first) |
| 🔧 | Detected tech stack (framework, library, CSS) |
| 🕵️ | Stealth mode active |

---

## Architecture (Need-to-Know)

- You talk to an MCP server over stdio. The server talks to a daemon over a Unix socket. The daemon talks to a Chrome extension over WebSocket. The extension controls Chrome.
- The extension runs in Chrome's isolated world — page JavaScript cannot detect it.
- CDP is only used for screenshots, network interception, and PDF generation. All DOM interaction goes through content scripts.
- The daemon persists across sessions. Managed Chromium quits on disconnect by default; enable extension Settings “Keep browser after session ends” to keep the window open. Profile cookies/logins always persist on disk. Daemon idle timeout or shutdown can still quit daemon-owned browsers.
- Every tool call is audit-logged to `~/.supersurf/logs/sessions/`.
