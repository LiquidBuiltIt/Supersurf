---
name: navigation
description: How to find your way around an unfamiliar site with SuperSurf — what to do when a selector misses, a new tab opens, a custom dropdown will not pick, an evaluate chain grows, or a CAPTCHA appears. Built from real SuperSurf usage data.
---

# Navigation

Find the symptom, apply the rule. Do not trust the tech-stack badge; read the DOM.

## Before You Act

- Prefer `#id` or `[data-testid="…"]` when the element has one. These succeeded 97% of the time over 966 calls.
- Always pass `action: 'url'` to `browser_navigate`. Example: `browser_navigate { action: 'url', url: 'https://example.com' }`.
- Set `screenshot: true` on the action instead of calling `browser_take_screenshot` after it.

## Selector Missed

- Never use Playwright syntax (`text=`, `>>`, `:visible`, `:near()`). All 39 such selectors failed. Use `tag:has-text("…")`: `button:has-text("Submit")`.
- On a miss, copy the tag and selector from the "Did you mean?" block, including its `@handle`.
- After one miss, call `browser_lookup { text: 'Submit' }`. Do not reach for `browser_snapshot` or `browser_evaluate`.
- Escape `[` and `]` in ids: `#answers\[0\]`, or use `[id="answers[0]"]`.

## Evaluate Chain Growing

Stop after 3 `browser_evaluate` calls in a row. Switch to `browser_lookup` or `browser_interact`.

## Custom Dropdowns

Click the trigger, then click the option: two `click` actions in one `browser_interact`. Use `select_option` only on a native `<select>`.

## New Tab After Sign-In

After "Continue with Google" or any SSO button, expect a new tab. Call `browser_tabs { action: 'list' }`, then `browser_tabs { action: 'attach', tabId: <id> }`.

## CAPTCHA on the Page

A badge, script or invisible widget alone is not a block. Keep going and judge by outcome.

You are blocked only when one of these is true:

- The challenge frame is on screen: a reCAPTCHA iframe whose `src` contains `bframe`, or the iframe titled "hCaptcha challenge", with real on-screen bounds. While passive it is parked at y=-9999 or `visibility:hidden`.
- A challenge page shows ("Just a moment", "verify you are human").
- An explicit error appears.
- A required token (`g-recaptcha-response`, `h-captcha-response`) is still empty after a real click.

A submit that silently does nothing is not CAPTCHA evidence. Check field state, Yes/No widgets and the validation banner first.

Enterprise reCAPTCHA frames come from `recaptcha.net/recaptcha/enterprise/`.

When blocked, stop and tell the user. Do not try to solve it.

## Site Types

Read the DOM, not the badge.

| DOM shows | Apply |
|---|---|
| Class names containing `react-select` or `__control` | Custom Dropdowns |
| SSO popup or "Continue with…" button | New Tab After Sign-In |
