import { registerAction } from './registry';
import { resolveInFrames, evalInFrameOrTop, getCenterInFrame } from '../lib/frames';
import { moveCursorTo } from './helpers';
import { OPTION_MATCHER_JS } from './option-matcher';

registerAction({
  name: 'select_custom',
  async run(ctx, action) {
    const triggerSelector = action.selector;
    const targetValue = action.value;
    if (!triggerSelector) throw new Error('select_custom requires a selector');
    if (!targetValue) throw new Error('select_custom requires a value');

    const expr = ctx.getSelectorExpression(triggerSelector);
    const triggerMatch = await resolveInFrames(ctx, expr);
    if (!triggerMatch) throw new Error(`No custom dropdown trigger found at ${triggerSelector}.`);
    const frameContextId = triggerMatch.contextId;

    const detection = await evalInFrameOrTop(ctx, `
      (() => {
        const el = ${expr};
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

    const beforeSnapshot = await evalInFrameOrTop(ctx, `
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

    const meta = { name: action.name, purpose: action.purpose };
    const { x, y } = await getCenterInFrame(ctx, triggerSelector, meta);
    await moveCursorTo(ctx, x, y, '_default');
    await ctx.cdp('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1,
    });
    await ctx.sleep(78 + Math.floor(Math.random() * 64));
    await ctx.cdp('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
    });
    await evalInFrameOrTop(ctx, `(() => {
      const el = document.elementFromPoint(${x}, ${y});
      if (el) el.click();
    })()`, frameContextId).catch(() => {});

    await ctx.sleep(300);

    const optionResult = await evalInFrameOrTop(ctx, `
      (() => {
        ${OPTION_MATCHER_JS}
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
    `, frameContextId);

    if (!optionResult?.found) {
      const availableMsg = optionResult?.available?.length
        ? ` Available: ${optionResult.available.join(', ')}`
        : '';
      throw new Error(`Option "${targetValue}" not found in dropdown.${availableMsg}`);
    }

    await ctx.sleep(150);

    const verification: any = await evalInFrameOrTop(ctx, `
      (() => {
        const el = ${expr};
        if (!el) return { verified: false, currentText: '' };
        const currentText = el.textContent?.trim().substring(0, 100) || '';
        const before = ${JSON.stringify(detection.triggerText)};
        return { verified: currentText !== before, currentText };
      })()
    `, frameContextId);

    if (verification?.verified) {
      return `Selected "${optionResult.optionText}" in custom dropdown ${triggerSelector}`;
    }
    return `⚠ Selected "${optionResult.optionText}" in custom dropdown ${triggerSelector} (unverified — trigger text unchanged after option click; the dropdown may not have committed selection state)`;
  },
});
