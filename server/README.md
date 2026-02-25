# supersurf-mcp

Free and open-source MCP server for browser automation — gives AI agents control of a real Chrome browser via a Chrome extension.

Works with any LLM that supports the [Model Context Protocol](https://modelcontextprotocol.io): Claude, GPT, Gemini, open-source models, or your own. Every line of code is public on GitHub — no telemetry, no data collection.

## Quick Start

**1. Install the Chrome extension**

Install from the [Chrome Web Store](https://chromewebstore.google.com/detail/falcdhojcinkkbffgnipppcdoaehgpek).

**2. Register the MCP server**

Claude Code:
```bash
claude mcp add supersurf -- npx supersurf-mcp@latest
```

Claude Desktop — add to your MCP config:
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

**3. Use it**

Your agent calls `enable` to start the session, the extension auto-connects, and 30+ browser tools become available.

## Tools

| Tool | Description |
|------|-------------|
| `enable` / `disable` / `status` | Session lifecycle |
| `browser_tabs` | List, create, attach, or close tabs |
| `browser_navigate` | Go to URL, back, forward, reload |
| `browser_interact` | Click, type, press keys, hover, scroll, wait, select, upload files |
| `browser_snapshot` | Accessibility tree as structured DOM |
| `browser_lookup` | Find elements by visible text |
| `browser_extract_content` | Page content as clean markdown |
| `browser_take_screenshot` | Viewport, full page, element, or region |
| `browser_evaluate` | Run JavaScript in page context |
| `browser_fill_form` | Set multiple form fields at once |
| `browser_network_requests` | Monitor, inspect, and replay network traffic |
| `browser_console_messages` | Read console output |
| `browser_get_element_styles` | Inspect computed CSS |
| `browser_drag` | Drag and drop |
| `browser_window` | Resize, minimize, maximize |
| `browser_verify_text_visible` | Assert text is on page |
| `browser_verify_element_visible` | Assert element is visible |
| `browser_pdf_save` | Export page as PDF |
| `browser_handle_dialog` | Accept/dismiss alerts and prompts |
| `browser_list_extensions` | List installed extensions |
| `browser_reload_extensions` | Reload unpacked extensions |
| `browser_performance_metrics` | Web Vitals (FCP, LCP, CLS, TTFB) |
| `browser_download` | Download a file via the browser |
| `browser_storage` | Inspect/modify localStorage and sessionStorage |
| `secure_fill` | Fill a field with a credential from an env var (agent never sees the value) |

## CLI Flags

```
--debug              Verbose logging + hot reload
--debug=no_truncate  Full payloads, no truncation
--port <n>           WebSocket port (default: 5555)
--log-file <path>    Custom log file path
--script-mode        JSON-RPC over stdio without MCP framing
```

Pass flags via your MCP config:
```json
{
  "args": ["supersurf-mcp@latest", "--debug", "--port", "5555"]
}
```

## How It Works

```
AI Agent  -->  MCP Server (stdio)  -->  WebSocket  -->  Chrome Extension  -->  Browser
```

All DOM interaction goes through Chrome content scripts (isolated world, invisible to page JS). CDP is only used for screenshots, network interception, and PDF export. Your agent browses with your real browser profile — cookies, history, localStorage, extensions.

## Requirements

- Node.js >= 18
- Chrome or Chromium
- [SuperSurf Chrome extension](https://chromewebstore.google.com/detail/falcdhojcinkkbffgnipppcdoaehgpek)

## License

Apache-2.0 with Commons Clause — free to use, modify, and redistribute, but not to sell. 100% open source.

[Full documentation](https://github.com/h8ngryDev4Hire/Supersurf)
