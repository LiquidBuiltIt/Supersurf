<div align="center">

# SuperSurf

**MCP-native browser automation. Any agent. Any model. Real browser. Undetectable.**

[![npm version](https://img.shields.io/npm/v/supersurf-mcp?style=flat-square&color=cb3837&label=npm)](https://www.npmjs.com/package/supersurf-mcp)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-8A2BE2?style=flat-square)](https://modelcontextprotocol.io)
[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?style=flat-square&logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions)
[![Tools](https://img.shields.io/badge/30%2B-browser%20tools-FF6F00?style=flat-square)](https://github.com/h8ngryDev4Hire/Supersurf#tools)

<br />

```mermaid
graph LR
    A["AI Agent"] -->|stdio| B["MCP Server"]
    B -->|WebSocket| C["Chrome Extension"]
    C -->|Content Scripts| D["Browser"]

    style A fill:#8A2BE2,stroke:#6A1B9A,color:#fff
    style B fill:#339933,stroke:#1B5E20,color:#fff
    style C fill:#4285F4,stroke:#1565C0,color:#fff
    style D fill:#FF6F00,stroke:#E65100,color:#fff
```

<br />

SuperSurf is an open-source MCP server that gives any AI agent control of a real Chrome browser.<br />
It works with any LLM that supports the [Model Context Protocol](https://modelcontextprotocol.io) — Claude, GPT, Gemini, open-source models, or your own.

Unlike tools that spin up headless browsers or inject CDP scripts, SuperSurf uses a Chrome extension to interact with pages through content scripts. Your agent operates in a real browser profile with your cookies, history, and localStorage intact — and page JavaScript can't detect it.

</div>

---

## Why SuperSurf?

<table>
<tr>
<td width="33%">

### vs. Puppeteer
CDP over pipe — detectable via `navigator.webdriver`, CDP leak, and `Runtime.evaluate` VM artifacts. Fresh profile by default. Credentials pass through your script in plaintext. One connection per browser.

</td>
<td width="33%">

### vs. Selenium
WebDriver protocol — `navigator.webdriver` flag, predictable DOM mutation patterns. Fresh profile. Credentials in plaintext. Widely fingerprinted by commercial anti-bot systems.

</td>
<td width="33%">

### SuperSurf
Content scripts in an isolated world — **invisible to page JS**. Your real browser profile. Credentials resolved extension-side from env vars — **agent never sees raw values**. Built-in multi-agent multiplexing.

</td>
</tr>
</table>

> Puppeteer and Selenium are great tools for scripted automation and testing. SuperSurf solves a different problem: giving an AI agent a browser that looks and behaves like a human's.

---

## Why Extension-Based?

> [!IMPORTANT]
> CDP-injected scripts appear as VM instances in memory profiling. Content scripts run in an **isolated world** that page JavaScript cannot observe. SuperSurf never touches the page's JS context for DOM interaction.

**Real browser profile.** No synthetic launch flags, no blank profile. Your agent browses with the same cookies, history, and extensions as a human user.

**Extension presence is a human signal.** Anti-bot systems check for installed extensions as evidence of a real user. A browser with zero extensions is suspicious.

> [!TIP]
> SuperSurf is CI-compatible out of the box. Sideload without user interaction:
> ```bash
> chrome --load-extension=./extension --user-data-dir=/tmp/supersurf-profile
> ```

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Load the Chrome extension
#    chrome://extensions → Developer mode → Load unpacked → select extension/ directory

# 3. Register with your MCP client
claude mcp add supersurf -- npx supersurf-mcp@latest  # Claude Code
```

<details>
<summary><strong>Claude Desktop config</strong></summary>

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
<summary><strong>From source (development)</strong></summary>

```bash
npm run mcp
# or manually:
claude mcp add supersurf -- node server/dist/cli.js
```

</details>

---

## Features

| | |
|---|---|
| **Undetectable DOM interaction** | All page interaction runs through Chrome's content script context. No CDP fingerprints, no VM script artifacts, nothing for page JavaScript to observe. |
| **Real browser profile** | Your agent browses with your actual cookies, history, localStorage, and extensions. No sterile headless environment. |
| **Secure credential handling** | `secure_fill` injects passwords from environment variables directly in the extension. The agent sends an env var *name*, never the value. |
| **30+ browser tools** | Full coverage: navigation, interaction, screenshots, network monitoring, console access, form filling, CSS inspection, PDF export, performance metrics, file downloads. |
| **Session multiplexing** | Multiple MCP clients share one browser. Leader/follower architecture with tab ownership tracking and round-robin scheduling. |
| **Framework detection** | Content script identifies 40+ frontend frameworks and libraries on any page. |
| **CI-ready** | Sideload the extension with `--load-extension` and a throwaway profile. No manual setup needed. |
| **Domain whitelist** | Optional navigation restriction using the Tranco top 100K list. Fetched once, cached locally, refreshed daily. |
| **Zero extension deps** | The Chrome extension uses browser APIs only. No bundled libraries, no supply chain surface. |

> [!NOTE]
> **Credentials never reach the agent.** `secure_fill` resolves env var values extension-side and types characters with randomized delays (40-120ms) to mimic human input. Your agent sends `"GITHUB_PASSWORD"`, not the password itself.

---

## Tools

<details>
<summary><strong>Session Management</strong></summary>

| Tool | Description |
|------|-------------|
| `enable` | Start browser automation session |
| `disable` | Stop browser automation session |
| `status` | Show connection state |
| `experimental_features` | Toggle experimental features |

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
| `browser_performance_metrics` | Collect Web Vitals (FCP, LCP, CLS, TTFB) |
| `browser_download` | Download a file via the browser |

</details>

<details>
<summary><strong>Extensions & Storage</strong></summary>

| Tool | Description |
|------|-------------|
| `browser_list_extensions` | List installed Chrome extensions |
| `browser_reload_extensions` | Reload unpacked extensions |
| `browser_storage` | Inspect/modify localStorage & sessionStorage *(requires `storage_inspection` experiment)* |
| `reload_mcp` | Hot-reload the MCP server *(debug mode only)* |

</details>

---

## Experimental Features

Toggle via the `experimental_features` tool or the `SUPERSURF_EXPERIMENTS` environment variable:

```bash
SUPERSURF_EXPERIMENTS=page_diffing,smart_waiting,mouse_humanization
```

| Experiment | Description |
|------------|-------------|
| **page_diffing** | After interactions, returns only DOM changes instead of a full re-read. Includes a confidence score. |
| **smart_waiting** | Replaces fixed delays with adaptive DOM stability + network idle detection. |
| **storage_inspection** | Inspect and modify browser storage (localStorage, sessionStorage). |
| **mouse_humanization** | Human-like Bezier trajectories, overshoot correction, and idle micro-movements. Hand-tuned from the Balabit Mouse Dynamics dataset. |
| **secure_eval** | Two-layer code analysis for `browser_evaluate`. Server-side AST parsing + extension-side Proxy membrane that blocks dangerous API access before execution. |
| **multiplexer** | Session multiplexing for concurrent MCP clients. Leader/follower architecture with tab ownership. *(env var only)* |

---

## Server CLI Flags

| Flag | Description |
|------|-------------|
| `--debug` | Verbose logging + hot reload (payloads truncated by default) |
| `--debug=no_truncate` | Full-verbosity debug — no payload truncation |
| `--port <n>` | WebSocket port (default: `5555`) |
| `--log-file <path>` | Custom server log file path |
| `--script-mode` | JSON-RPC over stdio without MCP framing |

<details>
<summary><strong>Debug log locations</strong></summary>

- **Server log:** `~/.supersurf/logs/server.log`
- **Session logs:** `~/.supersurf/logs/sessions/supersurf-debug-{client_id}-{timestamp}.log`

All WebSocket commands log params and responses. CDP passthrough unwraps to show inner methods. Base64 payloads (screenshots, PDFs) are auto-redacted in truncated mode.

</details>

---

## Prerequisites

- **Node.js** >= 18
- **Chrome** or Chromium
- An **MCP client** (Claude Code, Claude Desktop, etc.)

---

<div align="center">

**Apache-2.0 with Commons Clause** — free to use, modify, and redistribute, but not to sell.

Built by [The Media Masons](https://github.com/h8ngryDev4Hire)

</div>
