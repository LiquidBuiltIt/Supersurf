---
name: doctor
description: Check the health of a SuperSurf install and fix connection problems — MCP server and daemon versions, extension connection, profiles, playbooks, config drift, port conflicts. Use when connect fails, the extension will not connect, or the user asks to check SuperSurf.
---

# Doctor

## How to Run

Run every check below first. Report one table: `Check | Result | Status (✅/⚠️/❌) | Fix`. Then offer each fix one at a time and wait for the user's yes before running it. Never run the daemon with `--version` — it starts the daemon.

## Checks

| Check | How | Healthy when |
|---|---|---|
| MCP server version | `status` tool without `username` (first line, `SuperSurf v<version>`) | Matches latest |
| Latest published | `npm view supersurf-mcp version` | — |
| Daemon running | `supersurf daemon status` if `command -v supersurf` succeeds (the install.sh binary), otherwise `npx supersurf-daemon@latest status` | Running |
| Extension connected | `status` tool without `username` (health only): the `Extension:` line says `connected (<browser>)` or `not connected`. Pass your `username` to also see your own session and attached tab | `Extension: connected` with the expected browser |
| Profiles | `profile_list` | Each managed profile is listed |
| Playbooks | `playbooks` action `validate` | Every script validates |
| Config drift | Status header of a call that passes your `username` contains the `config.json changed since daemon start` warning | No warning |
| Port 5555 | `lsof -iTCP:5555 -sTCP:LISTEN` (macOS/Linux) or `ss -ltnp 'sport = :5555'` (Linux) | Only the SuperSurf daemon listens |
| Duplicate skill | `ls ~/.claude/skills/supersurf` | Absent (the plugin provides the skill) |

`status` without `username` reports health only (server version, daemon version and uptime, extension) and names no agent. It does not report the profile name. Use `supersurf daemon status` (or `npx supersurf-daemon@latest status` when `command -v supersurf` fails) for the daemon and `profile_list` for profiles.

## Symptoms and Fixes

| Symptom | Likely cause | Fix |
|---|---|---|
| `connect` times out for a managed profile | The profile lost its `supersurf_profile` binding | Re-run registration (command below) |
| Config-drift warning | `config.json` changed after the daemon started | `supersurf daemon restart`, or `npx supersurf-daemon@latest restart` when `command -v supersurf` fails |
| Port 5555 held by another process | A stale or foreign process owns the port | Stop that process, then `supersurf daemon restart` (or `npx supersurf-daemon@latest restart` when `command -v supersurf` fails) |
| Server version behind latest | Old install | Re-run the installer, or use `npx supersurf-mcp@latest` |
| Playbook fails validation | Script error | Run `playbooks` action `validate` on it and read the error; load `supersurf:creating-playbooks` |
| Duplicate `~/.claude/skills/supersurf/` | An old manual install shadows the plugin skill | Offer to remove it. This deletes files, so wait for the user's yes |

Registration command for a lost binding. Daemon-spawned profiles heal themselves, so use this only for Chromium you launched by hand:

```bash
# Kill any existing Chromium for the profile, then relaunch with registration URL
pkill -f "chromium.*PROFILE_NAME/chrome-data"
chromium \
  --user-data-dir=~/.supersurf/profiles/PROFILE_NAME/chrome-data \
  --load-extension=~/.supersurf/extension \
  --no-first-run --no-default-browser-check --use-mock-keychain \
  "http://127.0.0.1:5555/register/PROFILE_NAME"
```

Page-level problems (selectors, CAPTCHAs, dropdowns) belong to `supersurf:navigation`.
