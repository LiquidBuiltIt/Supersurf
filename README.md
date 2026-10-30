<div align="center">

# SuperSurf

**Let your agent do the driving.**

[![npm version](https://img.shields.io/npm/v/supersurf-mcp?style=flat-square&color=cb3837&label=npm)](https://www.npmjs.com/package/supersurf-mcp)
[![License](https://img.shields.io/badge/license-Apache--2.0_with_Commons_Clause-blue?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-8A2BE2?style=flat-square)](https://modelcontextprotocol.io)
[![Chrome Web Store](https://img.shields.io/badge/Chrome_Web_Store-Install-4285F4?style=flat-square&logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/falcdhojcinkkbffgnipppcdoaehgpek)
[![Tools](https://img.shields.io/badge/30-browser%20tools-FF6F00?style=flat-square)](https://github.com/liquidbuiltit/Supersurf#tools)

<br />

```mermaid
graph LR
    A["AI Agent"] -->|stdio| B["MCP Server"]
    B -->|Unix socket| E["Daemon"]
    E -->|WebSocket| C["Chrome Extension"]
    C -->|Content Scripts| D["Browser"]

    style A fill:#8A2BE2,stroke:#6A1B9A,color:#fff
    style B fill:#339933,stroke:#1B5E20,color:#fff
    style E fill:#1B5E20,stroke:#0D3B14,color:#fff
    style C fill:#4285F4,stroke:#1565C0,color:#fff
    style D fill:#FF6F00,stroke:#E65100,color:#fff
```

<br />

A browser-control layer for AI agents. It plugs into Claude Code, Codex, Cursor, Claude Desktop or any MCP client and runs as an extension inside the Chrome you already use: your tabs, your sessions, your logins. No second browser to log into.

</div>

---

## Teach Your AI Agent SuperSurf 🦀

> Send this to your agent:
>
> `Read https://liquidbuiltit.github.io/Supersurf/skill.md and follow the instructions to automate your browser`

1. Send the prompt above to your AI agent
2. Your agent reads the skill guide and learns SuperSurf's tools
3. They connect and start automating your browser

---

## What your agent can do with it

### Check its own frontend work
The agent opens the tab on your dev server, clicks through the change it just made, and reads what you would read: console output, network requests, matched CSS rules with file and line, page timings and the accessibility tree. It fixes what it finds and checks again.

### Do the chores that sit behind a login
Invoices in a vendor portal, forty records in a CRM, a report in an admin console. You are already signed in, so the agent is too: no second login, no 2FA prompt. Downloads go through your browser, so your cookies apply.

### Save it as a playbook, rerun it without the model
Once the agent gets a flow right, save it as a playbook: a script you rerun from your terminal with no model in the loop, as often as you like. Every run is logged.

---

## Quick Start

```bash
curl -fsSL https://liquidbuiltit.github.io/Supersurf/install.sh | sh
```

That installs the `supersurf` CLI to `~/.local/bin` (no sudo), starts the daemon, and walks you through the one step it cannot do for you: installing the Chrome extension from the Web Store. Then point your client at it:

```bash
claude mcp add supersurf -- supersurf mcp   # Claude Code
```

Re-run the same command to upgrade. In CI, Docker, or anywhere without a terminal, it skips every prompt on its own — pass `--yes` to force that:

```bash
curl -fsSL https://liquidbuiltit.github.io/Supersurf/install.sh | sh -s -- --yes
```

Pass `--client=claude` to skip the manual `claude mcp add` step above — the installer runs it for you once the extension is connected:

```bash
curl -fsSL https://liquidbuiltit.github.io/Supersurf/install.sh | sh -s -- --client=claude
```

<details>
<summary><strong>Without the CLI — point your client straight at npx</strong></summary>

The MCP server is on npm, so a client that can run `npx` needs no CLI installed. You still have to [install the extension from the Web Store](https://chromewebstore.google.com/detail/falcdhojcinkkbffgnipppcdoaehgpek) yourself.

```bash
claude mcp add supersurf -- npx supersurf-mcp@latest   # Claude Code
```

Claude Desktop:

```json
{
  "mcpServers": {
    "supersurf": {
      "command": "npx",
      "args": ["supersurf-mcp@latest"]
    }
  }
}
```

CLI flags can be appended to the args array:

```json
{
  "mcpServers": {
    "supersurf": {
      "command": "npx",
      "args": ["supersurf-mcp@latest", "--debug", "--port", "5555"]
    }
  }
}
```

</details>

<details>
<summary><strong>Other ways to get the extension</strong></summary>

The [Chrome Web Store listing](https://chromewebstore.google.com/detail/falcdhojcinkkbffgnipppcdoaehgpek) is the normal route, and the installer opens it for you. Two others exist:

- **Managed profiles need no install at all.** `supersurf profiles create <name>` launches a separate Chromium with the extension already sideloaded — the daemon downloads it from GitHub releases and caches it under `~/.supersurf/extension/`.
- **Manual unpacked load**, for development or an offline machine: download the release `.zip` from [GitHub releases](https://github.com/LiquidBuiltIt/Supersurf/releases), extract it, open `chrome://extensions`, enable Developer mode, then **Load unpacked** and select the extracted folder.
- **CI**, with no user interaction: `chrome --load-extension=./extension --user-data-dir=/tmp/supersurf-profile`.

</details>

<details>
<summary><strong>From source (development)</strong></summary>

```bash
npm ci
npm run build
npm run mcp
# or manually:
claude mcp add supersurf -- node server/dist/cli.js
```

</details>

---

## Packages

SuperSurf ships as **two** npm packages:

- **[`supersurf-mcp`](https://www.npmjs.com/package/supersurf-mcp)** — the MCP server. This is what you install and point your client at.
- **[`supersurf-daemon`](https://www.npmjs.com/package/supersurf-daemon)** — the coordinator daemon. It's a dependency of `supersurf-mcp`, spawned automatically; you never install or configure it directly.

> **Why two packages and not a single `supersurf`?** They were meant to merge into one `supersurf` package in v3. That name is squatted on npm by an abandoned `0.0.1` placeholder, and npm declined to review the claim — its Trust & Safety team does not arbitrate squatting, and the trademark route it offered instead is not worth pursuing for a FOSS name. The merge is cancelled: SuperSurf ships as these two packages permanently. The `supersurf` CLI installed by the script above is a compiled binary from GitHub releases, not an npm package, so the squat does not affect it.

---

## Safe to hand over

| | |
|---|---|
| **Passwords** | The agent sends the name of an environment variable. The extension types the value. The model never sees it. |
| **Page scripts** | Code the agent runs on a page is checked first. Network calls, storage access and navigation are blocked. On by default. |
| **Cleanup** | When the agent disconnects, the tabs it opened close. |
| **Domain allowlist** | Optional: limit navigation to the top 100K domains. |

## Also in the box

| | |
|---|---|
| **Several agents, one browser** | Each agent session owns the tabs it opens, so agents running side by side do not collide. Subagents of one client: opt in with `agents.multi_agent`. |
| **Self-healing selectors** *(experimental)* | When a page changes and a selector breaks, the element is found again by its fingerprint. |
| **Smart waiting** *(experimental)* | After an action, it waits for the page to settle before the agent reads it. |
| **Managed profiles** | Keep a second account apart in its own Chromium, with its own logins. |

---

## Tools

30 browser tools, grouped by job.

<details>
<summary><strong>Session Management</strong></summary>

| Tool | Description |
|------|-------------|
| `connect` | Connect and start a session named by `client_id`. Pass `profile` for an isolated Chromium instance. (Opt-in multi-agent mode, `agents.multi_agent`, takes `username` instead.) |
| `disconnect` | End your session: closes the tabs you created, releases tabs you attached to |
| `status` | Show current connection state: passive, active, or connected |
| `profile_create` | Create an isolated Chromium profile |
| `profile_list` | List all managed profiles |
| `profile_delete` | Delete a managed profile |

</details>

<details>
<summary><strong>Navigation & Tabs</strong></summary>

| Tool | Description |
|------|-------------|
| `browser_tabs` | List, create, attach, or close tabs |
| `browser_navigate` | Go to URL, back, forward, reload |
| `browser_window` | Resize, close, minimize, maximize |

</details>

<details>
<summary><strong>Page Interaction</strong></summary>

| Tool | Description |
|------|-------------|
| `browser_interact` | Click, type, press keys, hover, scroll, wait, select, upload files |
| `browser_fill_form` | Set values on multiple form fields at once |
| `browser_drag` | Drag one element to another |
| `browser_handle_dialog` | Accept or dismiss alerts/confirms/prompts |
| `secure_fill` | Fill a field with a credential from an env var (agent never sees the value) |

</details>

<details>
<summary><strong>Content & Inspection</strong></summary>

| Tool | Description |
|------|-------------|
| `browser_snapshot` | Get the page's accessibility tree as structured DOM |
| `browser_lookup` | Find elements by visible text, returns CSS selectors |
| `browser_extract_content` | Pull page content as clean markdown |
| `browser_get_element_styles` | Inspect computed CSS like DevTools Styles panel |
| `browser_evaluate` | Run JavaScript in page context |
| `browser_verify_text_visible` | Assert text is visible on page |
| `browser_verify_element_visible` | Assert element is visible on page |

</details>

<details>
<summary><strong>Capture & Monitoring</strong></summary>

| Tool | Description |
|------|-------------|
| `browser_take_screenshot` | Capture viewport, full page, element, or region |
| `browser_pdf_save` | Export page as PDF |
| `browser_console_messages` | Read console output, filter by level/text/URL |
| `browser_network_requests` | Monitor/inspect/replay network traffic |
| `browser_performance_metrics` | Collect page timings (TTFB, FCP, DOMContentLoaded, Load) |
| `browser_download` | Download a file via the browser |

</details>

<details>
<summary><strong>Extensions & Storage</strong></summary>

| Tool | Description |
|------|-------------|
| `browser_list_extensions` | List installed Chrome extensions |
| `browser_storage` | Inspect/modify localStorage & sessionStorage |
| `reload_mcp` | Hot-reload the MCP server *(debug mode only)* |

</details>

---

## Experimental Features

Configure via `~/.supersurf/config.json` (changes require a daemon restart) or the `SUPERSURF_EXPERIMENTS` environment variable:

```bash
SUPERSURF_EXPERIMENTS=page_diffing,smart_waiting,mouse_humanization
```

| Experiment | Description |
|------------|-------------|
| **page_diffing** | After interactions, returns only DOM changes instead of a full re-read. Includes a confidence score. |
| **smart_waiting** | Replaces fixed delays with adaptive DOM stability + network idle detection. |
| **mouse_humanization** | Human-like Bezier trajectories, overshoot correction, and idle micro-movements. Hand-tuned from the Balabit Mouse Dynamics dataset. |

---

## Server CLI Flags

| Flag | Description |
|------|-------------|
| `--debug` | Verbose logging + hot reload (payloads truncated by default) |
| `--debug=no_truncate` | Full-verbosity debug — no payload truncation |
| `--port <n>` | WebSocket port (default: `5555`) |
| `--log-file <path>` | Custom server log file path |
| `--script-mode` | JSON-RPC over stdio without MCP framing |
| `--disable-secure-eval` | Disable the default-on `secure_eval` analysis (AST + Proxy membrane) for `browser_evaluate` |

> [!NOTE]
> `secure_eval` — two-layer code analysis for `browser_evaluate` (server-side AST parsing + extension-side Proxy membrane that blocks dangerous API access before execution) — is **on by default**. Disable it with the `--disable-secure-eval` flag or `SUPERSURF_DISABLE_SECURE_EVAL=1`.

<details>
<summary><strong>Debug log locations</strong></summary>

- **Server log:** `~/.supersurf/logs/server.log`
- **Session logs:** `~/.supersurf/logs/sessions/supersurf-debug-{client_id}-{timestamp}.log`

All WebSocket commands log params and responses. CDP passthrough unwraps to show inner methods. Base64 payloads (screenshots, PDFs) are auto-redacted in truncated mode.

</details>

---

## Prerequisites

- **Node.js** >= 18
- **Chrome** or Chromium — on Ubuntu/Mint, **must be a deb install, not a Snap**. Snap Chromium's `home` interface denies access to hidden directories, breaking managed profiles under `~/.supersurf/`. Fix on Mint: `sudo snap remove chromium && sudo apt install chromium`. Ubuntu has no first-party deb — use `google-chrome-stable` from Google's signed apt repo instead.
- An **MCP client** (Claude Code, Claude Desktop, etc.)
- **macOS or Linux** — Windows is not currently supported. [Vote for Windows support](https://github.com/LiquidBuiltIt/Supersurf/issues/1) if you'd like to see it.

---

## Support

SuperSurf is **free and open-source**. If it saves you time, you can support continued development:

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-supersurf-FFDD00?style=flat-square&logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/supersurf)

---

<div align="center">

**100% Open Source** — Apache-2.0 with Commons Clause. Free to use, modify, and redistribute, but not to sell.

Built by [The Media Masons](https://github.com/liquidbuiltit)

</div>
