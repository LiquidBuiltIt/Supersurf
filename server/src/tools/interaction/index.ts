/**
 * Interaction tool handlers — click, type, scroll, hover, etc.
 *
 * Handles the `browser_interact` tool which accepts an ordered array of
 * actions and executes them sequentially. Integrates with two experimental
 * features: page_diffing (captures DOM before/after and returns a diff)
 * and mouse_humanization (generates Bezier-curve mouse paths).
 *
 * All mouse interactions go through CDP `Input.dispatch*` events with
 * realistic timing based on the Balabit Mouse Dynamics dataset.
 *
 * @module tools/interaction
 */

import type { ToolContext } from '../lib/types';
import { experimentRegistry, diffSnapshots, calculateConfidence, formatDiffSection } from '../../experimental/index';
import { executeAction } from './registry';

// Side-effect: each module calls registerAction() at load time.
import './mouse-move';
import './mouse-click';
import './press-key';
import './clear';
import './scroll';
import './select-option';
import './force-pseudo-state';
import './hover';
import './wait';
import './click';
import './type';
import './select-custom';
import './file-upload';

/**
 * Execute a sequence of page interactions (click, type, hover, scroll, etc.).
 *
 * Optionally captures DOM state before/after for page diffing, and returns
 * per-action success/failure results. The `onError` arg controls whether
 * the sequence stops on first failure or continues.
 *
 * @param ctx - Tool context with CDP/eval/extension access
 * @param args - `{ actions: Action[], onError?: 'stop'|'ignore', screenshot?: boolean }`
 * @param options - `{ rawResult?: boolean }`
 */
export async function onInteract(ctx: ToolContext, args: any, options: any): Promise<any> {
  const actions = args.actions as any[];
  const onError = (args.onError as string) || 'stop';
  const results: string[] = [];

  // === EXPERIMENTAL: page diffing — capture before state ===
  let beforeState: any = null;
  const isOnlyScrollActions = actions.every((a: any) =>
    ['scroll_to', 'scroll_by', 'scroll_into_view'].includes(a.type)
  );
  const captureMode = isOnlyScrollActions ? 'viewport' : 'document';
  if (experimentRegistry.isEnabled('page_diffing')) {
    try { beforeState = await ctx.ext.sendCmd('capturePageState', { mode: captureMode }); }
    catch { /* silently skip — extension may not support it yet */ }
  }

  for (const action of actions) {
    try {
      const msg = await executeAction(ctx, action);
      // Handlers may return a message starting with `⚠ ` to signal a soft
      // unverified result (mutation ran but post-action read-back didn't
      // confirm). Strip the marker and use it as the line prefix instead of ✓.
      const isWarn = typeof msg === 'string' && msg.startsWith('⚠ ');
      const body = isWarn ? msg.slice(2) : msg;
      results.push(`${isWarn ? '⚠' : '✓'} ${action.type}: ${body}`);
    } catch (error: any) {
      results.push(`✗ ${action.type}: ${error.message}`);
      if (onError === 'stop') break;
    }
  }

  // === EXPERIMENTAL: page diffing — capture after state and diff ===
  let diffSection = '';
  if (beforeState) {
    try {
      // Let smooth scroll animations settle before capturing viewport
      if (isOnlyScrollActions) await ctx.sleep(350);
      const afterState = await ctx.ext.sendCmd('capturePageState', { mode: captureMode });
      const confidence = calculateConfidence(afterState);
      if (confidence >= 0.5) {
        diffSection = formatDiffSection(diffSnapshots(beforeState, afterState), confidence, afterState, captureMode);
      } else {
        diffSection = `\n\n---\n**Page diff:** confidence below threshold (${Math.round(confidence * 100)}%) — full re-read recommended`;
      }
    } catch { /* silently skip */ }
  }

  if (options.rawResult) {
    return { success: !results.some(r => r.startsWith('✗')), actions: results };
  }

  return {
    content: [{ type: 'text', text: results.join('\n') + diffSection }],
    isError: results.some(r => r.startsWith('✗')),
  };
}
