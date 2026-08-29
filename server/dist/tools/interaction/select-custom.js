"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const registry_1 = require("./registry");
const frames_1 = require("../lib/frames");
const helpers_1 = require("./helpers");
const option_matcher_1 = require("./option-matcher");
(0, registry_1.registerAction)({
    name: 'select_custom',
    async run(ctx, action) {
        const triggerSelector = action.selector;
        const targetValue = action.value;
        if (!triggerSelector)
            throw new Error('select_custom requires a selector');
        if (!targetValue)
            throw new Error('select_custom requires a value');
        const expr = ctx.getSelectorExpression(triggerSelector);
        const meta = { name: action.name, purpose: action.purpose };
        const triggerMatch = await (0, frames_1.resolveInFrames)(ctx, expr, triggerSelector, meta);
        if (!triggerMatch)
            throw new Error(`No custom dropdown trigger found at ${triggerSelector}.`);
        const frameContextId = triggerMatch.contextId;
        const detection = await (0, frames_1.evalInFrameOrTop)(ctx, `
      (() => {
        const el = ${triggerMatch.resolvedExpr};
        if (!el) return { found: false };
        const isCustomSelect =
          el.getAttribute('role') === 'combobox' ||
          el.getAttribute('role') === 'listbox' ||
          el.getAttribute('aria-haspopup') === 'listbox' ||
          el.getAttribute('aria-haspopup') === 'true' ||
          el.classList.contains('css-1s2u09g-control') ||
          !!el.querySelector('[class*="indicatorContainer"]') ||
          el.getAttribute('data-headlessui-state') !== null ||
          el.getAttribute('data-radix-select-trigger') !== null;
        if (!isCustomSelect) {
          const parent = el.closest('[role="combobox"], [role="listbox"], [aria-haspopup="listbox"], [data-headlessui-state], [data-radix-select-trigger]');
          if (!parent) return { found: false };
        }
        return {
          found: true,
          triggerSelector: ${JSON.stringify(triggerSelector)},
          triggerText: el.textContent?.trim().substring(0, 100) || '',
        };
      })()
    `, frameContextId);
        if (!detection?.found) {
            throw new Error(`No custom dropdown trigger found at ${triggerSelector}. Use select_option for native <select> elements.`);
        }
        const beforeSnapshot = await (0, frames_1.evalInFrameOrTop)(ctx, `
      (() => {
        const sels = [
          '[role="option"]', '[role="menuitem"]',
          '[data-headlessui-state] li',
          '[class*="option"]', '[class*="menu"] [class*="option"]',
          '[id*="listbox"] [role="option"]',
          '[id*="react-select"] [id*="option"]',
        ];
        const ids = new Set();
        for (const sel of sels) {
          for (const el of document.querySelectorAll(sel)) {
            ids.add(el.getAttribute('id') || el.textContent?.trim()?.substring(0, 80) || '');
          }
        }
        return [...ids];
      })()
    `, frameContextId) || [];
        const { x, y } = await (0, frames_1.getCenterInFrame)(ctx, triggerSelector, meta);
        await (0, helpers_1.moveCursorTo)(ctx, x, y);
        await ctx.cdp('Input.dispatchMouseEvent', {
            type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1,
        });
        await ctx.sleep(78 + Math.floor(Math.random() * 64));
        await ctx.cdp('Input.dispatchMouseEvent', {
            type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
        });
        await (0, frames_1.evalInFrameOrTop)(ctx, `(() => {
      const el = document.elementFromPoint(${x}, ${y});
      if (el) el.click();
    })()`, frameContextId).catch(() => { });
        const scanExpr = `
      (() => {
        ${option_matcher_1.OPTION_MATCHER_JS}
        const target = ${JSON.stringify(targetValue)};
        const beforeIds = new Set(${JSON.stringify(beforeSnapshot)});
        const optionSelectors = [
          '[role="option"]',
          '[role="menuitem"]',
          '[data-headlessui-state] li',
          '[class*="option"]',
          '[class*="menu"] [class*="option"]',
          '[id*="listbox"] [role="option"]',
          '[id*="react-select"] [id*="option"]',
        ];
        const newOptions = [];
        for (const sel of optionSelectors) {
          for (const opt of document.querySelectorAll(sel)) {
            const optId = opt.getAttribute('id') || opt.textContent?.trim()?.substring(0, 80) || '';
            if (!beforeIds.has(optId)) newOptions.push(opt);
          }
        }
        const candidates = newOptions.length > 0 ? newOptions : (() => {
          const all = [];
          for (const sel of optionSelectors) {
            for (const opt of document.querySelectorAll(sel)) all.push(opt);
          }
          return all;
        })();
        const pairs = candidates.map((opt) => ({
          text: opt.textContent?.trim() || '',
          value: opt.getAttribute('data-value') || opt.getAttribute('value') || '',
        }));
        const idx = matchOption(target, pairs);
        if (idx >= 0) {
          const opt = candidates[idx];
          const matched = pairs[idx];
          opt.scrollIntoView({ block: 'nearest' });
          opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          opt.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          opt.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return { found: true, optionText: matched.text || matched.value };
        }
        const available = [];
        for (const p of pairs) {
          if (p.text && !available.includes(p.text)) available.push(p.text);
        }
        return { found: false, available: available.slice(0, 20) };
      })()
    `;
        // Poll for options instead of one fixed sleep — dropdowns animate, fetch
        // async, or virtualize. Stop early once any candidates render.
        let optionResult = null;
        for (let attempt = 0; attempt < 6; attempt++) {
            await ctx.sleep(250);
            optionResult = await (0, frames_1.evalInFrameOrTop)(ctx, scanExpr, frameContextId);
            if (optionResult?.found)
                break;
            if (optionResult?.available?.length)
                break; // options rendered — no point polling further
        }
        if (!optionResult?.found && !optionResult?.available?.length) {
            throw new Error(`Dropdown at ${triggerSelector} did not render any options within 1.5s — ` +
                `it may not have opened, or it renders options only after typing. ` +
                `If it is a native <select>, use select_option instead.`);
        }
        // Type-to-filter fallback: ATS combos (Workday, ADP, react-select) often
        // virtualize the list — the target option enters the DOM only after the
        // filter input narrows it. Set the value the React-safe way (native
        // setter + input event) and rescan once.
        let usedFilter = false;
        if (!optionResult?.found) {
            const typed = await (0, frames_1.evalInFrameOrTop)(ctx, `
        (() => {
          const el = ${triggerMatch.resolvedExpr};
          if (!el) return false;
          let input = el.matches('input:not([type=hidden]), textarea')
            ? el
            : el.querySelector('input:not([type=hidden]), textarea');
          if (!input && document.activeElement &&
              document.activeElement.matches('input:not([type=hidden]), textarea')) {
            input = document.activeElement;
          }
          if (!input) return false;
          const proto = input.tagName === 'TEXTAREA'
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(input, ${JSON.stringify(targetValue)});
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()
      `, frameContextId).catch(() => false);
            if (typed) {
                usedFilter = true;
                await ctx.sleep(500);
                optionResult = await (0, frames_1.evalInFrameOrTop)(ctx, scanExpr, frameContextId);
            }
        }
        if (!optionResult?.found) {
            const availableMsg = optionResult?.available?.length
                ? ` Available: ${optionResult.available.join(', ')}`
                : '';
            const filterNote = usedFilter ? ' (also tried typing the value into the combobox filter)' : '';
            throw new Error(`Option "${targetValue}" not found in dropdown.${filterNote}${availableMsg}`);
        }
        await ctx.sleep(150);
        const verification = await (0, frames_1.evalInFrameOrTop)(ctx, `
      (() => {
        const el = ${triggerMatch.resolvedExpr};
        if (!el) return { verified: false, currentText: '' };
        const currentText = el.textContent?.trim().substring(0, 100) || '';
        const before = ${JSON.stringify(detection.triggerText)};
        return { verified: currentText !== before, currentText };
      })()
    `, frameContextId);
        const via = usedFilter ? ' (after typing filter)' : '';
        if (verification?.verified) {
            return `Selected "${optionResult.optionText}" in custom dropdown ${triggerSelector}${via}`;
        }
        return `⚠ Selected "${optionResult.optionText}" in custom dropdown ${triggerSelector}${via} (unverified — trigger text unchanged after option click; the dropdown may not have committed selection state)`;
    },
});
//# sourceMappingURL=select-custom.js.map