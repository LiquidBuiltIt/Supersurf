/**
 * Content extraction tool handlers — snapshot, lookup, extract.
 *
 * Provides three read-only tools for inspecting page content:
 * - `browser_snapshot`: Returns the accessibility tree as indented role/name pairs
 * - `browser_lookup`: Finds elements by visible text, returning selectors and positions
 * - `browser_extract_content`: Converts page content to clean markdown with pagination
 *
 * @module tools/content
 */

import type { ToolContext } from './lib/types';

/**
 * Coalesce adjacent `InlineTextBox` siblings under the same parent into a single
 * text node. Chrome's AX tree splits long text runs into one `InlineTextBox` per
 * visual line, which bloats snapshot output and makes it harder to read. This
 * merges consecutive InlineTextBox nodes that share the same `parentId` into one
 * node whose `name.value` is the joined text. Non-InlineTextBox siblings between
 * two InlineTextBox nodes break the run — nothing is merged across element types.
 *
 * Names are trimmed, collapsed on internal whitespace, and joined with a single
 * space. The first node of a run is kept (depth, parentId, etc.) and has its
 * `name.value` replaced with the coalesced text.
 *
 * Raw result mode (`rawResult: true`) bypasses this — callers opting into raw
 * data get the unmodified CDP output.
 */
export function coalesceInlineTextBoxes(nodes: any[]): any[] {
  if (!Array.isArray(nodes) || nodes.length === 0) return nodes || [];
  const out: any[] = [];
  let i = 0;
  while (i < nodes.length) {
    const node = nodes[i];
    const role = node?.role?.value;
    if (role === 'InlineTextBox') {
      const parentId = node.parentId;
      const texts: string[] = [];
      const pushText = (raw: any) => {
        const normalized = String(raw ?? '').replace(/\s+/g, ' ').trim();
        if (normalized) texts.push(normalized);
      };
      pushText(node?.name?.value);
      let j = i + 1;
      while (
        j < nodes.length &&
        nodes[j]?.role?.value === 'InlineTextBox' &&
        nodes[j]?.parentId === parentId
      ) {
        pushText(nodes[j]?.name?.value);
        j++;
      }
      if (j === i + 1) {
        // Single InlineTextBox — still normalize its own name for consistency.
        out.push({
          ...node,
          name: { ...(node.name || {}), value: texts.join(' ') },
        });
      } else {
        out.push({
          ...node,
          name: { ...(node.name || {}), value: texts.join(' ') },
        });
      }
      i = j;
      continue;
    }
    out.push(node);
    i++;
  }
  return out;
}

/**
 * Return the page's accessibility tree as indented text.
 * Filters out generic/none roles to keep output meaningful.
 */
export async function onSnapshot(ctx: ToolContext, options: any): Promise<any> {
  const result = await ctx.ext.sendCmd('snapshot', {});

  // Use form fields from extension if available, otherwise collect via eval
  let formFields = result?.formFields;
  if (!formFields) {
    formFields = await ctx.eval(`
      (() => {
        const fields = [];
        const inputs = document.querySelectorAll('input, textarea, select');
        for (const el of inputs) {
          if (el.type === 'hidden') continue;
          let sel = el.tagName.toLowerCase();
          if (el.id) sel += '#' + el.id;
          else if (el.name) sel += '[name="' + el.name + '"]';
          else if (el.className && typeof el.className === 'string') {
            const cls = el.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2);
            if (cls.length) sel += '.' + cls.join('.');
          }

          const field = {
            selector: sel,
            tag: el.tagName.toLowerCase(),
            type: el.type || null,
            name: el.name || null,
            value: el.tagName === 'SELECT' ? el.value : (el.value || ''),
            required: el.required || false,
            label: null,
          };

          if (el.id) {
            const label = document.querySelector('label[for="' + el.id + '"]');
            if (label) field.label = label.textContent?.trim() || null;
          }
          if (!field.label && el.closest('label')) {
            field.label = el.closest('label').textContent?.trim() || null;
          }
          if (!field.label) {
            field.label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || null;
          }

          if (el.tagName === 'SELECT') {
            field.options = Array.from(el.options).map(o => o.textContent?.trim() || o.value);
          }

          if (el.type === 'checkbox' || el.type === 'radio') {
            field.checked = el.checked;
          }

          fields.push(field);
        }
        return fields;
      })()
    `).catch(() => []);
  }

  if (options.rawResult) {
    return { ...result, formFields: formFields || [] };
  }

  const rawNodes = result?.nodes || [];
  const nodes = coalesceInlineTextBoxes(rawNodes);
  if (nodes.length === 0 && (!formFields || formFields.length === 0)) {
    return { content: [{ type: 'text', text: 'Empty accessibility tree' }] };
  }

  let output = '';
  for (const node of nodes) {
    const role = node.role?.value || '';
    const name = node.name?.value || '';
    if (!role || role === 'none' || role === 'generic') continue;
    const indent = '  '.repeat(node.depth || 0);
    output += `${indent}[${role}] ${name}\n`;
  }

  if (!output) output = 'No meaningful accessibility nodes\n';

  if (formFields && formFields.length > 0) {
    output += '\n---\n### Form Fields\n\n';
    for (const f of formFields) {
      const parts = [`\`${f.selector}\``];
      if (f.label) parts.push(`label="${f.label}"`);
      if (f.type) parts.push(`type=${f.type}`);
      if (f.required) parts.push('required');
      if (f.checked !== undefined) parts.push(f.checked ? 'checked' : 'unchecked');
      if (f.value) parts.push(`value="${f.value}"`);
      if (f.options) parts.push(`options=[${f.options.join(', ')}]`);
      output += `- ${parts.join(' | ')}\n`;
    }
  }

  return { content: [{ type: 'text', text: output }] };
}

/**
 * Find elements by visible text and return their selectors, positions, and visibility.
 * Prioritizes visible matches over hidden ones.
 *
 * @param args - `{ text: string, limit?: number }`
 */
export async function onLookup(ctx: ToolContext, args: any, options: any): Promise<any> {
  const searchText = args.text as string;
  const limit = (args.limit as number) || 10;

  const data = await ctx.eval(`
    (() => {
      const searchText = ${JSON.stringify(searchText)};
      const searchLower = searchText.trim().toLowerCase();
      const matches = [];

      for (const el of document.querySelectorAll('*')) {
        let directText = '';
        for (const n of el.childNodes) {
          if (n.nodeType === Node.TEXT_NODE) directText += n.textContent;
        }
        directText = directText.trim();
        if (!directText.toLowerCase().includes(searchLower)) continue;

        let sel = el.tagName.toLowerCase();
        if (el.id) sel += '#' + el.id;
        else if (el.className && typeof el.className === 'string') {
          const cls = el.className.trim().split(/\\\\s+/).filter(c => c).slice(0, 2);
          if (cls.length) sel += '.' + cls.join('.');
        }

        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const visible = style.display !== 'none' && style.visibility !== 'hidden' &&
                        style.opacity !== '0' && rect.width > 0 && rect.height > 0;

        matches.push({
          selector: sel, visible,
          text: directText.length > 100 ? directText.substring(0, 100) + '...' : directText,
          tag: el.tagName.toLowerCase(),
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          formField: (() => {
            const t = el.tagName;
            if (t !== 'INPUT' && t !== 'TEXTAREA' && t !== 'SELECT') return undefined;
            const ff = {
              type: el.type || null,
              name: el.name || null,
              value: t === 'SELECT' ? el.value : (el.value || ''),
              required: el.required || false,
              label: null,
            };
            if (el.id) {
              const lbl = document.querySelector('label[for="' + el.id + '"]');
              if (lbl) ff.label = lbl.textContent?.trim() || null;
            }
            if (!ff.label && el.closest('label')) ff.label = el.closest('label').textContent?.trim() || null;
            if (!ff.label) ff.label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || null;
            if (t === 'SELECT') {
              ff.options = Array.from(el.options).map(o => o.textContent?.trim() || o.value);
            }
            if (el.type === 'checkbox' || el.type === 'radio') ff.checked = el.checked;
            return ff;
          })(),
        });
      }

      const visible = matches.filter(m => m.visible);
      const hidden = matches.filter(m => !m.visible);
      return { matches: [...visible, ...hidden].slice(0, ${limit}), total: matches.length };
    })()
  `);

  if (options.rawResult) return data;

  const matches = data?.matches || [];
  if (matches.length === 0) {
    return { content: [{ type: 'text', text: `No elements found with text: "${searchText}"` }] };
  }

  let output = `### Found ${data.total} element(s) with text: "${searchText}"\n\n`;
  matches.forEach((m: any, i: number) => {
    const vis = m.visible ? '✓' : '✗ hidden';
    output += `${i + 1}. **${m.selector}** [${m.tag}] ${vis}\n`;
    output += `   Text: "${m.text}"\n   Position: (${m.x}, ${m.y}) | Size: ${m.width}×${m.height}px\n`;
    if (m.formField) {
      const f = m.formField;
      const parts: string[] = [];
      if (f.label) parts.push(`label="${f.label}"`);
      if (f.type) parts.push(`type=${f.type}`);
      if (f.required) parts.push('required');
      if (f.checked !== undefined) parts.push(f.checked ? 'checked' : 'unchecked');
      if (f.value) parts.push(`value="${f.value}"`);
      if (f.options) parts.push(`options: [${f.options.join(', ')}]`);
      output += `   Form: ${parts.join(' | ')}\n`;
    }
    output += '\n';
  });

  return { content: [{ type: 'text', text: output }] };
}

/**
 * Extract page content as clean markdown with pagination support.
 *
 * Modes:
 * - `auto`: Tries common content selectors (article, main, .content), falls back to body
 * - `full`: Uses document.body directly
 * - `selector`: Targets a specific CSS selector
 *
 * @param args - `{ mode?: string, selector?: string, max_lines?: number, offset?: number }`
 */
export async function onExtractContent(ctx: ToolContext, args: any, options: any): Promise<any> {
  const mode = (args.mode as string) || 'auto';
  const maxLines = (args.max_lines as number) || 500;
  const offset = (args.offset as number) || 0;
  const selector = args.selector as string | undefined;

  const content = await ctx.eval(`
    (() => {
      function getRoot() {
        ${mode === 'selector' && selector
          ? `return document.querySelector(${JSON.stringify(selector)});`
          : mode === 'full'
          ? `return document.body;`
          : `// Auto-detect main content
             const candidates = ['article', 'main', '[role="main"]', '.content', '.post', '#content'];
             for (const s of candidates) {
               const el = document.querySelector(s);
               if (el && el.textContent.trim().length > 100) return el;
             }
             return document.body;`
        }
      }

      function toMarkdown(el) {
        if (!el) return '';
        const lines = [];

        function walk(node) {
          if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent.trim();
            if (text) lines.push(text);
            return;
          }
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          const tag = node.tagName.toLowerCase();

          if (['script', 'style', 'noscript', 'svg'].includes(tag)) return;
          if (window.getComputedStyle(node).display === 'none') return;

          if (/^h[1-6]$/.test(tag)) {
            const level = parseInt(tag[1]);
            lines.push('#'.repeat(level) + ' ' + node.textContent.trim());
            return;
          }
          if (tag === 'p') { lines.push(node.textContent.trim()); lines.push(''); return; }
          if (tag === 'br') { lines.push(''); return; }
          if (tag === 'a') {
            lines.push('[' + node.textContent.trim() + '](' + (node.href || '') + ')');
            return;
          }
          if (tag === 'img') {
            lines.push('![' + (node.alt || '') + '](' + (node.src || '') + ')');
            return;
          }
          if (tag === 'li') { lines.push('- ' + node.textContent.trim()); return; }
          if (tag === 'code' && node.parentElement?.tagName !== 'PRE') {
            lines.push('\\\\u0060' + node.textContent + '\\\\u0060');
            return;
          }
          if (tag === 'pre') {
            lines.push('\\\\u0060\\\\u0060\\\\u0060');
            lines.push(node.textContent);
            lines.push('\\\\u0060\\\\u0060\\\\u0060');
            return;
          }

          for (const child of node.childNodes) walk(child);
        }

        walk(el);
        return lines;
      }

      const root = getRoot();
      if (!root) return { error: 'No content element found' };
      return { lines: toMarkdown(root) };
    })()
  `);

  if (content?.error) return ctx.error(content.error, options);

  const allLines = content?.lines || [];
  const slice = allLines.slice(offset, offset + maxLines);
  const truncated = allLines.length > offset + maxLines;

  if (options.rawResult) {
    return { lines: slice, total: allLines.length, offset, truncated };
  }

  let text = slice.join('\n');
  if (truncated) {
    text += `\n\n_...truncated (showing ${slice.length} of ${allLines.length} lines, offset=${offset})_`;
  }

  return { content: [{ type: 'text', text }] };
}
