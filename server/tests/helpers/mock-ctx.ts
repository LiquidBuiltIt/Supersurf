import { vi } from 'vitest';
import type { ToolContext } from '../../src/tools/lib/types';

export function createMockCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    ext: { sendCmd: vi.fn().mockResolvedValue({ success: true }) } as any,
    agentSession: {
      setAttachedTab: vi.fn(),
      setStealthMode: vi.fn(),
      clearAttachedTab: vi.fn(),
      attachedTab: null,
    } as any, // deliberate partial mock of AgentSessionAPI
    cdp: vi.fn().mockResolvedValue({}),
    eval: vi.fn().mockResolvedValue(undefined),
    sleep: vi.fn().mockResolvedValue(undefined),
    getElementCenter: vi.fn().mockResolvedValue({ x: 100, y: 100 }),
    getSelectorExpression: vi.fn((s: string) => `document.querySelector("${s}")`),
    findAlternativeSelectors: vi.fn().mockResolvedValue([]),
    formatResult: vi.fn((_name, result, _opts) => ({ content: [{ type: 'text', text: JSON.stringify(result) }] })),
    error: vi.fn((msg, _opts) => ({ content: [{ type: 'text', text: msg }], isError: true })),
    ...overrides,
  };
}
