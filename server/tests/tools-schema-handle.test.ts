import { describe, it, expect } from 'vitest';
import { getToolSchemas } from '../src/tools/schemas';

describe('browser_interact schema — handle fields', () => {
  it('exposes name and purpose on each action item', () => {
    const interact = getToolSchemas().find(s => s.name === 'browser_interact')!;
    const itemProps = (interact.inputSchema as any).properties.actions.items.properties;
    expect(itemProps.name).toBeDefined();
    expect(itemProps.name.type).toBe('string');
    expect(itemProps.purpose).toBeDefined();
    expect(itemProps.purpose.type).toBe('string');
  });
  it('keeps the item-level required array at type only — the naming requirement is conditional', () => {
    const interact = getToolSchemas().find(s => s.name === 'browser_interact')!;
    const items = (interact.inputSchema as any).properties.actions.items;
    // Unconditional `required` would reject scroll_by/press_key/wait, which never target an
    // element. The requirement rides the allOf/if/then block below instead.
    expect(items.required).toEqual(['type']);
  });

  it('requires name and purpose for element-targeting actions that carry a selector', () => {
    const interact = getToolSchemas().find(s => s.name === 'browser_interact')!;
    const items = (interact.inputSchema as any).properties.actions.items;
    expect(Array.isArray(items.allOf)).toBe(true);

    const rule = items.allOf.find((r: any) => r.then?.required?.includes('name'));
    expect(rule).toBeDefined();
    expect(rule.then.required).toEqual(['name', 'purpose']);

    // Fires only when BOTH the action type is element-targeting AND a selector is present.
    expect(rule.if.required).toEqual(['type', 'selector']);
    expect(rule.if.properties.selector.type).toBe('string');
    expect(rule.if.properties.type.enum).toEqual([
      'click', 'type', 'clear', 'hover', 'select_option', 'select_custom', 'file_upload',
    ]);
  });

  it('behaviorally requires name/purpose only for element-targeting actions with a selector', () => {
    const interact = getToolSchemas().find(s => s.name === 'browser_interact')!;
    const items = (interact.inputSchema as any).properties.actions.items;
    const rule = items.allOf.find((r: any) => r.then?.required?.includes('name'));

    // Hand-rolled if/then evaluator driven off the LIVE schema object (rule.if / rule.then), not
    // hardcoded constants — so it actually exercises what's shipped, not a re-implementation of
    // what we intended to ship. Understands exactly `required` + `properties.{enum,type:string}`;
    // any other JSON Schema keyword in the `if` block (e.g. `not`) throws rather than silently
    // treating the condition as met, so a semantically-fatal but structurally-additive edit (like
    // `not: {}`, which leaves every key the other tests read completely untouched) is caught here
    // instead of passing invisibly.
    const knownIfKeys = new Set(['required', 'properties']);
    function ifMatches(ifBlock: any, action: Record<string, unknown>): boolean {
      for (const key of Object.keys(ifBlock)) {
        if (!knownIfKeys.has(key)) {
          throw new Error(
            `behavioral evaluator does not understand if-block keyword "${key}" — refusing to ` +
            'assume the condition is met',
          );
        }
      }
      for (const key of ifBlock.required ?? []) {
        if (!(key in action)) return false;
      }
      for (const [prop, propSchema] of Object.entries<any>(ifBlock.properties ?? {})) {
        if (!(prop in action)) continue;
        if (Array.isArray(propSchema.enum) && !propSchema.enum.includes(action[prop])) return false;
        if (propSchema.type === 'string' && typeof action[prop] !== 'string') return false;
      }
      return true;
    }
    function requiresNaming(action: Record<string, unknown>): boolean {
      if (!ifMatches(rule.if, action)) return false;
      const thenRequired: string[] = rule.then?.required ?? [];
      return thenRequired.includes('name') && thenRequired.includes('purpose');
    }

    expect(requiresNaming({ type: 'click', selector: '#a' })).toBe(true);
    expect(requiresNaming({ type: 'click', x: 1, y: 2 })).toBe(false);
    expect(requiresNaming({ type: 'wait', selector: '#a' })).toBe(false);
    expect(requiresNaming({ type: 'file_upload', selector: '#f' })).toBe(true);
  });

  it('does not require naming for actions that never target an element', () => {
    const interact = getToolSchemas().find(s => s.name === 'browser_interact')!;
    const items = (interact.inputSchema as any).properties.actions.items;
    const rule = items.allOf.find((r: any) => r.then?.required?.includes('name'));
    for (const t of [
      'mouse_move', 'mouse_click', 'press_key', 'wait',
      'scroll_to', 'scroll_by', 'scroll_into_view', 'force_pseudo_state',
    ]) {
      expect(rule.if.properties.type.enum).not.toContain(t);
    }
  });

  it('no longer tells the agent a differing name becomes an alias', () => {
    const interact = getToolSchemas().find(s => s.name === 'browser_interact')!;
    const itemProps = (interact.inputSchema as any).properties.actions.items.properties;
    expect(itemProps.name.description).not.toContain('alias');
  });
  it('advertises handle names in the selector description', () => {
    const interact = getToolSchemas().find(s => s.name === 'browser_interact')!;
    const itemProps = (interact.inputSchema as any).properties.actions.items.properties;
    const desc = itemProps.selector.description as string;
    expect(desc).toContain('snake_case');
    expect(desc).toContain('handle');
    // Still documents the CSS surface it always did.
    expect(desc).toContain(':has-text');
  });
  it('discloses the fingerprinting experiment gate on the selector description', () => {
    const interact = getToolSchemas().find(s => s.name === 'browser_interact')!;
    const itemProps = (interact.inputSchema as any).properties.actions.items.properties;
    const desc = itemProps.selector.description as string;
    expect(desc).toContain('fingerprinting');
    expect(desc).toContain('off by default');
  });
  it('discloses the domain + URL path scope of handle resolution on the selector description', () => {
    const interact = getToolSchemas().find(s => s.name === 'browser_interact')!;
    const itemProps = (interact.inputSchema as any).properties.actions.items.properties;
    const desc = itemProps.selector.description as string;
    expect(desc).toContain('URL path');
    expect(desc).toContain('no cross-route matching');
  });
});
