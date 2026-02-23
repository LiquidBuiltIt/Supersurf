/**
 * CSS styles inspection tool handler.
 *
 * Implements `browser_get_element_styles` — a DevTools Styles panel equivalent
 * for AI agents. Uses CDP's CSS domain to retrieve matched CSS rules,
 * inline styles, and computed values for a given selector.
 *
 * Features:
 * - Property filtering (inspect a single CSS property)
 * - Pseudo-state forcing (hover, focus, active, etc.)
 * - Source tracking with file:line references
 * - Applied/overridden/computed markers for cascade visibility
 *
 * @module tools/styles
 */

import type { ToolContext } from './types';

/** Strip content hashes from CSS filenames: `frontend-abc123.css` → `frontend.css` */
function cleanCSSFilename(href: string): string {
  const parts = href.split('/');
  let filename = parts[parts.length - 1].split('?')[0];
  filename = filename.replace(/-[a-f0-9]{6,16}\./, '.');
  return filename;
}

/**
 * Inspect computed and matched CSS rules for an element.
 *
 * Resolves the element via CDP DOM.querySelector, optionally forces pseudo-states,
 * then collects all matched rules and inline styles into a property map with
 * source/selector/importance tracking. Cleans up forced pseudo-states on exit.
 *
 * @param args - `{ selector: string, property?: string, pseudoState?: string[] }`
 */
export async function onGetElementStyles(ctx: ToolContext, args: any, options: any): Promise<any> {
  const selector = args.selector as string;
  const propertyFilter = args.property ? (args.property as string).toLowerCase() : null;
  let pseudoState = args.pseudoState || [];
  if (typeof pseudoState === 'string') {
    try { pseudoState = JSON.parse(pseudoState); } catch { pseudoState = [pseudoState]; }
  }

  // Resolve nodeId from selector
  const doc = await ctx.cdp('DOM.getDocument', {});
  const queryResult = await ctx.cdp('DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector,
  });
  if (!queryResult.nodeId) throw new Error(`Element not found: ${selector}`);

  // Force pseudo states if requested
  if (pseudoState.length > 0) {
    await ctx.cdp('CSS.forcePseudoState', {
      nodeId: queryResult.nodeId,
      forcedPseudoClasses: pseudoState,
    });
  }

  // Get matched styles
  const styles = await ctx.cdp('CSS.getMatchedStylesForNode', { nodeId: queryResult.nodeId });

  // Collect external CSS file list for source heuristic
  const externalCSSFiles: string[] = await ctx.eval(`
    Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
      .map(l => l.href).filter(Boolean)
  `) || [];

  const matchedRules = styles.matchedCSSRules || [];
  const inlineStyle = styles.inlineStyle;

  // Collect properties with source tracking
  const propMap = new Map<string, any[]>();

  for (const ruleMatch of matchedRules) {
    const rule = ruleMatch.rule;
    if (!rule?.style) continue;

    const origin = rule.origin || 'regular';
    const selectorText = rule.selectorList?.selectors?.map((s: any) => s.text).join(', ') || '';

    // Resolve source with file + line number
    let source: string;
    if (origin === 'user-agent') {
      source = 'browser default';
    } else if (rule.styleSheetId) {
      const lineNum = rule.style.range ? rule.style.range.startLine + 1 : '?';
      let filename: string | null = null;
      if (externalCSSFiles.length >= 1) {
        filename = cleanCSSFilename(externalCSSFiles[0]);
      }
      source = filename ? `${filename}:${lineNum}` : `stylesheet:${lineNum}`;
    } else {
      source = origin || 'stylesheet';
    }

    for (const prop of rule.style.cssProperties || []) {
      const name = prop.name?.toLowerCase();
      if (!name || !prop.value?.trim()) continue;
      if (propertyFilter && name !== propertyFilter) continue;

      if (!propMap.has(name)) propMap.set(name, []);
      propMap.get(name)!.push({
        value: prop.value,
        source,
        selector: selectorText,
        important: prop.important || false,
        disabled: prop.disabled || false,
      });
    }
  }

  if (inlineStyle?.cssProperties) {
    for (const prop of inlineStyle.cssProperties) {
      const name = prop.name?.toLowerCase();
      if (!name || !prop.value?.trim()) continue;
      if (propertyFilter && name !== propertyFilter) continue;

      if (!propMap.has(name)) propMap.set(name, []);
      propMap.get(name)!.push({
        value: prop.value,
        source: 'inline',
        selector: 'element.style',
        important: prop.important || false,
        disabled: prop.disabled || false,
      });
    }
  }

  // Mark computed duplicates — when the same source/selector/importance combo
  // produces different values, the last one is tagged as [computed] by the browser
  propMap.forEach((values) => {
    const sourceGroups = new Map<string, number[]>();
    values.forEach((decl: any, idx: number) => {
      const key = `${decl.source}|${decl.selector}|${decl.important}`;
      if (!sourceGroups.has(key)) sourceGroups.set(key, []);
      sourceGroups.get(key)!.push(idx);
    });
    sourceGroups.forEach((indices) => {
      if (indices.length > 1) {
        const srcVal = values[indices[0]].value;
        const compVal = values[indices[indices.length - 1]].value;
        if (srcVal !== compVal) {
          values[indices[indices.length - 1]].computed = true;
        }
      }
    });
  });

  // Clean up pseudo states
  if (pseudoState.length > 0) {
    await ctx.cdp('CSS.forcePseudoState', {
      nodeId: queryResult.nodeId,
      forcedPseudoClasses: [],
    }).catch(() => {});
  }

  if (options.rawResult) {
    const properties: Record<string, any[]> = {};
    propMap.forEach((v, k) => { properties[k] = v; });
    return { success: true, selector, propertyCount: propMap.size, properties };
  }

  let output = `### Element Styles: \`${selector}\`\n\n`;

  if (pseudoState.length > 0) {
    output += `**Forced pseudo-state:** \`${pseudoState.map((s: string) => `:${s}`).join(', ')}\`\n\n`;
  }

  if (propMap.size === 0) {
    output += propertyFilter
      ? `No CSS property \`${propertyFilter}\` found for this element.\n`
      : 'No CSS styles found.\n';
    return { content: [{ type: 'text', text: output }] };
  }

  output += `Found ${propMap.size} CSS ${propMap.size === 1 ? 'property' : 'properties'}:\n\n`;
  const sorted = Array.from(propMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));

  for (const [name, values] of sorted) {
    output += `\n${name}:\n`;

    let appliedIndex = values.length - 1;
    for (let i = values.length - 1; i >= 0; i--) {
      if (!values[i].computed) { appliedIndex = i; break; }
    }

    values.forEach((decl: any, idx: number) => {
      const imp = decl.important ? ' !important' : '';
      const disabled = decl.disabled ? ' [disabled]' : '';
      const markers: string[] = [];

      if (decl.computed) markers.push('[computed]');
      const isApplied = idx === appliedIndex;
      if (isApplied && !decl.important) markers.push('[applied]');
      if (!decl.important && !isApplied && !decl.computed) markers.push('[overridden]');

      const markerStr = markers.length > 0 ? ' ' + markers.join(' ') : '';
      output += `  ${decl.value}${imp}${disabled}${markerStr}\n`;
      output += `    ${decl.source}`;
      if (decl.selector && decl.selector !== 'element.style') output += ` — ${decl.selector}`;
      output += '\n';
    });
  }

  return { content: [{ type: 'text', text: output }] };
}
