---
name: supersurf
description: Drive a real Chrome browser through the SuperSurf MCP server. Use when a task needs a live browser session. Lists every SuperSurf feature, the hard rules, and which supersurf:* skill to load for navigation, playbooks, or install problems.
---

# SuperSurf — Agent Skill Guide

> You control a real Chrome browser. Real cookies, real sessions, real history. You are not using a headless browser or a simulator — you are operating a full Chrome instance with a human's profile.

Start every session like this:

```
connect client_id='my-task'
browser_tabs action='list'
browser_tabs action='attach' tabId=123
browser_snapshot
...
disconnect
```

Every response starts with a status header: connection state, attached tab, detected tech stack.

## Hard Rules

1. Call `connect`, then attach a tab (`browser_tabs` action `attach`), before any other browser tool.
2. Run `browser_snapshot` or `browser_lookup` before acting. Never guess a selector.
3. Never type a credential. Use `secure_fill`; if the credential is missing, ask the user.
4. Do not take a screenshot to read text. Use `browser_snapshot` or `browser_extract_content`.
5. Do not use `browser_evaluate` for work a dedicated tool does. Never work around a `secure_eval` block.
6. When a response carries `_dialogs`, resolve it with `browser_handle_dialog` before the next page call.
7. Refer to tabs by `tabId`, not by index.
8. Wait for an element (`browser_interact` action `wait`), not a fixed sleep.
9. Follow a tip's suggestion. Tips are appended to results when a better path exists.

## Feature Tour

| Area | What it does | Tools | Deeper skill |
|------|--------------|-------|--------------|
| Connection & status | Opens and closes your daemon session; `connect` takes an optional `profile`. `status` reports the connection. | `connect`, `disconnect`, `status` | `supersurf:doctor` |
| Tabs & navigation | List, open, attach and close tabs (`list`, `new`, `attach`, `close`). Navigate by `url`, `back`, `forward`, `reload`. Popups (`windowType: 'popup'`) are attachable. | `browser_tabs`, `browser_navigate`, `browser_window` | — |
| Reading pages | `browser_snapshot` returns the accessibility tree. `browser_lookup text=` returns selectors, visibility and position. `browser_extract_content` returns markdown (`mode='auto'`, `'full'` or `'selector'`). | `browser_snapshot`, `browser_lookup`, `browser_extract_content`, `browser_verify_text_visible`, `browser_verify_element_visible` | `supersurf:navigation` |
| Interacting | `browser_interact` runs an array of actions in order. Actions: `click`, `type`, `clear`, `press_key`, `hover`, `mouse_move`, `mouse_click`, `scroll_to`, `scroll_by`, `scroll_into_view`, `wait`, `select_option`, `select_custom`, `file_upload`, `force_pseudo_state`. `onError` is `'stop'` (default) or `'ignore'`. Give element actions a `name` and `purpose`. | `browser_interact`, `browser_drag` | `supersurf:navigation` |
| Forms & credentials | `browser_fill_form` fills inputs, textareas, selects, checkboxes and radios. `secure_fill` types a credential from a server environment variable, char by char; you never see the value. | `browser_fill_form`, `secure_fill` | — |
| Dialogs | `alert`, `confirm`, `prompt` and `beforeunload` are held open. Use `action` `view`, `accept` (with `text=` for a prompt) or `dismiss`. | `browser_handle_dialog` | — |
| Profiles | An isolated Chromium with its own cookies, logins and history. Names are lowercase alphanumeric and hyphens, max 32 characters. | `profile_create`, `profile_list`, `profile_delete` | `supersurf:doctor` |
| Playbooks | A `.playbook.js` script in `~/.supersurf/playbooks/`. You write the file yourself. `history` lists this session's working selectors; `run` needs the `fingerprinting` experiment. | `playbooks` (`history`, `list`, `inspect`, `validate`, `run`) | `supersurf:creating-playbooks` |
| Network & console | List, filter, inspect, replay and clear captured requests. Read console output by `level` or `text`. Core Web Vitals. | `browser_network_requests`, `browser_console_messages`, `browser_performance_metrics` | — |
| CSS inspection | Matched rules with source file and line, computed values, and `pseudoState` forcing. | `browser_get_element_styles` | — |
| Storage | Read and write `localStorage` or `sessionStorage`. `type` is required; `action` is `get`, `set`, `delete`, `clear` or `list`; `key` is required for `get`, `set` and `delete`; `set` also takes `value`. | `browser_storage` | — |
| Screenshots & PDF | Viewport JPEG by default; `fullPage`, `selector` and `path` are options. With no `path`, output follows `screenshot.omit_path` in `~/.supersurf/config.json`. | `browser_take_screenshot`, `browser_pdf_save` | — |
| Downloads | Downloads through the browser, so real cookies apply. Optional `filename` and `destination`. | `browser_download` | — |
| Experiments | Four opt-in features, listed in the glossary. Set them in `~/.supersurf/config.json`, then restart the daemon. | — | — |
| Extensions | Lists installed Chrome extensions. | `browser_list_extensions` | — |

## Skills

| Skill | Load when | Link |
|-------|-----------|------|
| `supersurf:navigation` | You read pages, find elements, or click and type, and want to do it reliably. | [SKILL.md](https://github.com/LiquidBuiltIt/Supersurf/blob/main/plugin/skills/navigation/SKILL.md) |
| `supersurf:doctor` | `connect` fails, the extension is missing, or a version looks wrong. | [SKILL.md](https://github.com/LiquidBuiltIt/Supersurf/blob/main/plugin/skills/doctor/SKILL.md) |
| `supersurf:creating-playbooks` | You want to save a working flow as a `.playbook.js` script. | [SKILL.md](https://github.com/LiquidBuiltIt/Supersurf/blob/main/plugin/skills/creating-playbooks/SKILL.md) |

## Glossary

| Term | Meaning |
|------|---------|
| tab attach | Binding your session to one browser tab; every browser tool acts on the attached tab. |
| status header | The line prepended to every result: connection, browser, attached tab and URL, tech stack, and warnings such as `No tab attached` or a config-drift notice. |
| `_dialogs` | A warning on a tool result that says a native dialog is held open; page-touching calls stay blocked until you resolve it. |
| handle | An `@name` written in place of a selector. "Did you mean?" hints on an element miss mint ephemeral handles that resolve without `fingerprinting`; handles you name with `name` on `browser_interact` need the `fingerprinting` experiment. |
| `:has-text()` | A selector suffix such as `a:has-text("Sign in")` that picks the first match whose text contains the string. |
| secure_eval | The AST check that blocks unsafe `browser_evaluate` code (writes, storage access, navigation). |
| profile | A managed, isolated Chromium instance; its cookies and logins persist on disk between sessions. |
| playbook | A `~/.supersurf/playbooks/<name>.playbook.js` script that exports `meta` and a default async function. |
| experiment | One of `page_diffing`, `smart_waiting`, `mouse_humanization` or `fingerprinting`. Toggle in `~/.supersurf/config.json` under `experiments`; a daemon restart applies it. |
| tip | A hint appended to a tool result when a purpose-built tool would serve you better. |

## Architecture

- You talk to an MCP server over stdio. The server talks to a daemon over a Unix socket. The daemon talks to a Chrome extension over WebSocket. The extension controls Chrome.
- The extension runs in Chrome's isolated world — page JavaScript cannot detect it.
- CDP is only used for screenshots, network interception, and PDF generation. All DOM interaction goes through content scripts.
- The daemon persists across sessions. Managed Chromium quits on disconnect by default; enable extension Settings "Keep browser after session ends" to keep the window open. Profile cookies/logins always persist on disk. Daemon idle timeout or shutdown can still quit daemon-owned browsers.
