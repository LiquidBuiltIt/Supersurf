# Changelog

All notable changes to SuperSurf are documented in this file.

Format: `feat` = new capability, `fix` = bug fix, `security` = hardening, `chore` = maintenance.

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
