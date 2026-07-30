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
  it('does not add name/purpose to the item-level required array (never-reject)', () => {
    const interact = getToolSchemas().find(s => s.name === 'browser_interact')!;
    const required = (interact.inputSchema as any).properties.actions.items.required;
    expect(required).toEqual(['type']);
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
});
