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
  it('keeps the item-level required array at type only', () => {
    const interact = getToolSchemas().find(s => s.name === 'browser_interact')!;
    const items = (interact.inputSchema as any).properties.actions.items;
    // Naming is advisory — carried in the field descriptions, never as a structural rule.
    expect(items.required).toEqual(['type']);
  });

  it('uses NO JSON Schema composition keywords anywhere in the tool schema', () => {
    // Regression lock. A conditional allOf/if/then naming requirement shipped here and was
    // reverted: the MCP spec restricts inputSchema to type/properties/required, and a client
    // that chokes on composition keywords drops the ENTIRE tool from tools/list rather than
    // ignoring the keyword. Silent and total. Walk the whole schema, not just the action item,
    // so a keyword reintroduced at any depth (top level, a nested array item, a sub-object)
    // is caught rather than only the one spot the original block happened to live in.
    const interact = getToolSchemas().find(s => s.name === 'browser_interact')!;
    const banned = ['allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', '$ref', 'dependentSchemas'];
    const hits: string[] = [];

    function walk(node: unknown, path: string): void {
      if (Array.isArray(node)) {
        node.forEach((child, i) => walk(child, `${path}[${i}]`));
        return;
      }
      if (node === null || typeof node !== 'object') return;
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        if (banned.includes(key)) hits.push(`${path}.${key}`);
        walk(child, `${path}.${key}`);
      }
    }
    walk(interact.inputSchema, 'inputSchema');

    expect(hits).toEqual([]);
  });

  it('still tells the agent in prose that naming is required for element-targeting actions', () => {
    // The requirement did not disappear with the schema rule — it moved to the descriptions,
    // which is the only channel every MCP client renders. If this prose is ever dropped, the
    // requirement stops being communicated at all.
    const interact = getToolSchemas().find(s => s.name === 'browser_interact')!;
    const itemProps = (interact.inputSchema as any).properties.actions.items.properties;
    expect(itemProps.name.description).toContain('REQUIRED');
    expect(itemProps.purpose.description).toContain('REQUIRED');
    for (const t of ['click', 'type', 'clear', 'hover', 'select_option', 'select_custom', 'file_upload']) {
      expect(itemProps.name.description).toContain(t);
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
