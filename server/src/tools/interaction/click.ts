import { registerAction } from './registry';
import { getCenterInFrame, evalInFrameOrTop } from '../lib/frames';
import { moveCursorTo, detectSpawnedTabs } from './helpers';
import { experimentRegistry } from '../../experimental/index';

/**
 * Build the page-context expression that arms the click side-effect probe.
 *
 * Records a pre-click snapshot (focus, URL, target aria-state), installs a
 * one-shot capture listener on the target (proves the event *reached* it), and
 * starts a subtree MutationObserver (proves something observable *changed*).
 * State lives on `window.__ssClickProbe` so the post-click read can retrieve it.
 * Tagged `ss:arm` for test identification. Best-effort — never throws into the
 * click path.
 */
function armProbeExpr(targetExpr: string): string {
  return `(() => {
    try {
      const t = ${targetExpr};
      const w = window;
      const ariaOf = (el) => el ? [el.getAttribute('aria-expanded'), el.getAttribute('aria-pressed'),
        el.getAttribute('aria-checked'), el.getAttribute('aria-selected')].join('|') : null;
      w.__ssClickProbe = {
        startURL: location.href,
        startActive: document.activeElement,
        target: t,
        startAria: ariaOf(t),
        reached: false,
        mutated: false,
      };
      if (t) {
        w.__ssClickProbe._cap = function () { if (w.__ssClickProbe) w.__ssClickProbe.reached = true; };
        t.addEventListener('click', w.__ssClickProbe._cap, { capture: true });
      }
      const obs = new MutationObserver(function () { if (w.__ssClickProbe) w.__ssClickProbe.mutated = true; });
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      w.__ssClickProbe._obs = obs;
    } catch (e) { /* probe is best-effort */ }
  })() /* ss:arm */`;
}

/**
 * Page-context expression that reads the probe back and tears it down.
 * Returns `{ ok, hadTarget, reached, mutated, focusChanged, urlChanged,
 * ariaChanged }`. Tagged `ss:read`. Returns `{ ok: false }` if the probe was
 * never armed (e.g. service-worker restart between arm and read).
 */
const READ_PROBE_EXPR = `(() => {
  const w = window;
  const p = w.__ssClickProbe;
  if (!p) return { ok: false };
  try { if (p._obs) p._obs.disconnect(); } catch (e) {}
  const t = p.target;
  const ariaOf = (el) => el ? [el.getAttribute('aria-expanded'), el.getAttribute('aria-pressed'),
    el.getAttribute('aria-checked'), el.getAttribute('aria-selected')].join('|') : null;
  const out = {
    ok: true,
    hadTarget: !!t,
    reached: !!p.reached,
    mutated: !!p.mutated,
    focusChanged: document.activeElement !== p.startActive,
    urlChanged: location.href !== p.startURL,
    ariaChanged: ariaOf(t) !== p.startAria,
  };
  try { if (t && p._cap) t.removeEventListener('click', p._cap, { capture: true }); } catch (e) {}
  try { delete w.__ssClickProbe; } catch (e) {}
  return out;
})() /* ss:read */`;

/**
 * Turn the probe read-back into an honest, agent-facing verdict — the
 * confidence ladder: dispatched → reached-target → produced-side-effect.
 *
 * Transparent-core: we *report* what observably happened and let the agent
 * decide. We do NOT auto-retry or escalate the input method — that opinionated
 * behavior is deferred to opt-in smart mode (see the smart-mode roadmap).
 *
 * A `⚠ `-prefixed string is the established soft-warning signal that
 * `onInteract` renders with a `⚠` line marker.
 */
function describeClickOutcome(target: string, probe: any, hadSpawn: boolean): string {
  const base = `Clicked ${target}`;
  // No usable probe (child-frame edge, eval error, unexpected shape, or no
  // element under the cursor): stay silent rather than emit a false warning.
  if (!probe || probe.ok !== true || !probe.hadTarget) return base;

  const sideEffect = hadSpawn || probe.mutated || probe.focusChanged || probe.urlChanged || probe.ariaChanged;
  if (sideEffect) return base;

  if (probe.reached) {
    return `⚠ ${base} — the event reached the element but nothing observable changed ` +
      `(no DOM mutation, focus, URL, or aria change). A handler may not have fired; ` +
      `re-snapshot to confirm before assuming it worked.`;
  }
  return `⚠ ${base} — the synthetic click did not reach the element ` +
    `(an overlay may be intercepting it, or the coordinates are stale). ` +
    `Scroll it into view or re-snapshot for fresh coordinates, then retry.`;
}

registerAction({
  name: 'click',
  async run(ctx, action) {
    const clickTimestamp = Date.now();
    let x: number, y: number;
    let clickContextId: number | null = null;
    if (action.selector) {
      const c = await getCenterInFrame(ctx, action.selector);
      x = c.x; y = c.y; clickContextId = c.contextId;
    } else if (action.x !== undefined && action.y !== undefined) {
      x = action.x;
      y = action.y;
    } else {
      throw new Error('click requires either a selector or {x, y}');
    }

    const button = action.button || 'left';
    const clickCount = action.clickCount || 1;

    // Resolve the click target the way the synthetic click lands on it: by
    // selector inside the resolved frame, or by point for coordinate clicks.
    const targetExpr = action.selector
      ? ctx.getSelectorExpression(action.selector)
      : `document.elementFromPoint(${x}, ${y})`;

    // Arm the side-effect probe BEFORE dispatching so the observer/listener
    // are live for the click itself.
    await evalInFrameOrTop(ctx, armProbeExpr(targetExpr), clickContextId).catch(() => {});

    await moveCursorTo(ctx, x, y, '_default');
    await ctx.cdp('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button, clickCount, buttons: 1,
    });
    await ctx.sleep(78 + Math.floor(Math.random() * 64));
    await ctx.cdp('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button, clickCount,
    });

    const domClickExpr = `(() => {
      const el = document.elementFromPoint(${x}, ${y});
      if (el && (el.closest('a[href]') || el.onclick)) el.click();
    })()`;
    await evalInFrameOrTop(ctx, domClickExpr, clickContextId).catch(() => {});

    if (experimentRegistry.isEnabled('smart_waiting')) {
      try { await ctx.ext.sendCmd('waitForReady', { timeout: 3000, stabilityMs: 300 }); }
      catch { /* non-blocking */ }
    }

    // detectSpawnedTabs sleeps ~300ms — doubles as the settle window before we
    // read the probe back, so we don't pay a second sleep.
    const spawned = await detectSpawnedTabs(ctx, clickTimestamp);
    const probe = await evalInFrameOrTop(ctx, READ_PROBE_EXPR, clickContextId).catch(() => null);

    const target = action.selector ? `${action.selector} at (${x}, ${y})` : `(${x}, ${y})`;
    const verdict = describeClickOutcome(target, probe, !!spawned);
    return spawned ? `${verdict}\n${spawned}` : verdict;
  },
});
