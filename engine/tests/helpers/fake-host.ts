import { vi } from 'vitest';
import type { DaemonLink } from 'shared';
import type { EngineHost } from '../../src/host';

/** A connected, healthy link. Override any field per test. */
export function fakeLink(over: Record<string, unknown> = {}): DaemonLink {
  return {
    connected: true,
    browser: 'chrome',
    buildTime: null,
    version: '0.1.0',
    extensionConnected: true,
    extensionVersionError: null,
    activeSessionCount: 1,
    onReconnect: null,
    onTabInfoUpdate: null,
    sendCmd: vi.fn().mockResolvedValue(undefined),
    notifyClientId: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    consumeDialogEvents: vi.fn(() => []),
    isConfigDrifted: vi.fn(() => false),
    getPeerSessions: vi.fn(() => []),
    ...over,
  } as unknown as DaemonLink;
}

/** An EngineHost whose members are vi mocks. `runConfig` throws unless a test stubs it. */
export function createFakeHost(over: Partial<EngineHost> = {}): EngineHost {
  return {
    packageVersion: '0.1.0',
    openLink: vi.fn(async () => fakeLink()),
    queryDaemonStatus: vi.fn(async () => null),
    runConfig: vi.fn(() => {
      throw new Error('runConfig not stubbed in this test');
    }),
    ...over,
  };
}
