/**
 * bindSessionState / releaseSessionState — the bind/release pair for every
 * per-session store. Mocks only the session-log registry (no disk writes);
 * every other store is real.
 */

import { describe, it, expect, vi } from 'vitest';

const { logs } = vi.hoisted(() => ({ logs: new Map<string, unknown>() }));

vi.mock('shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('shared')>();
  return {
    ...actual,
    createLog: () => () => {},
    getRegistry: () => ({
      debugMode: true,
      setSessionLog: (id: string) => {
        const logger = { logFilePath: '/tmp/x.log', log: vi.fn(), disable: vi.fn() };
        logs.set(id, logger);
        return logger;
      },
      clearSessionLog: (id: string) => {
        logs.delete(id);
      },
    }),
  };
});

import { bindSessionState, releaseSessionState } from '../src/backend/handlers';
import { experimentRegistry } from '../src/experimental/index';
import {
  bindEphemeral,
  resolveEphemeralBinding,
} from '../src/experimental/fingerprinting/ephemeral-handles';
import {
  initSession as initHumanization,
  getSession,
} from '../src/experimental/mouse-humanization/index';
import { trailFor } from '../src/playbooks/trail';
import { getTip } from '../src/tips';

const id = 'state-probe';
const transport = { connected: false, sendCmd: vi.fn() } as any;
const queryEval = { expression: "document.querySelector('h1').textContent" };
const entry = {
  tool: 'browser_tabs',
  type: 'browser_tabs',
  outcome: 'ok' as const,
  message: 'm',
  params: {},
};
const saturate = () => {
  for (let i = 0; i < 4; i++) getTip('browser_evaluate', queryEval, 'ok', undefined, id);
};

describe('session state bind/release', () => {
  it('bindSessionState opens the session log and resets a reused id', () => {
    trailFor(id).record(entry);
    saturate();
    bindSessionState(id, transport);
    expect(logs.has(id)).toBe(true);
    expect(trailFor(id).tail(10).total).toBe(0);
    expect(getTip('browser_evaluate', queryEval, 'ok', undefined, id)).toContain('browser_lookup');
    releaseSessionState(id);
  });

  it('releaseSessionState leaves no entry in any of the six stores', () => {
    bindSessionState(id, transport);
    experimentRegistry.enable(id, 'page_diffing');
    bindEphemeral(id, 'probe_button', '#probe', {
      matchSource: 'text',
      matchValue: 'Probe',
      x: 1,
      y: 1,
    });
    initHumanization(id);
    trailFor(id).record(entry);
    saturate();
    expect(experimentRegistry.isEnabled('page_diffing', id)).toBe(true);
    expect(resolveEphemeralBinding('probe_button')).not.toBeNull();
    expect(getSession(id)).toBeDefined();
    expect(trailFor(id).tail(10).total).toBe(1);
    expect(getTip('browser_evaluate', queryEval, 'ok', undefined, id)).toBeNull();
    expect(logs.has(id)).toBe(true);

    releaseSessionState(id);

    expect(logs.has(id)).toBe(false);
    expect(getTip('browser_evaluate', queryEval, 'ok', undefined, id)).toContain('browser_lookup');
    expect(trailFor(id).tail(10).total).toBe(0);
    expect(experimentRegistry.isEnabled('page_diffing', id)).toBe(false);
    expect(resolveEphemeralBinding('probe_button')).toBeNull();
    expect(getSession(id)).toBeUndefined();
  });
});
