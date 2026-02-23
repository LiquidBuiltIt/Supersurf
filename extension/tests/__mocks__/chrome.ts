/**
 * Shared Chrome API mock for extension tests.
 * Provides stub implementations of the Chrome APIs used by SuperSurf.
 */
import { vi } from 'vitest';

export function createMockChrome() {
  const listeners: Record<string, Function[]> = {};

  function makeEvent() {
    const eventListeners: Function[] = [];
    return {
      addListener: vi.fn((fn: Function) => eventListeners.push(fn)),
      removeListener: vi.fn((fn: Function) => {
        const idx = eventListeners.indexOf(fn);
        if (idx >= 0) eventListeners.splice(idx, 1);
      }),
      _fire: (...args: any[]) => eventListeners.forEach((fn) => fn(...args)),
      _listeners: eventListeners,
    };
  }

  const storage: Record<string, any> = {};

  return {
    tabs: {
      query: vi.fn(async () => []),
      create: vi.fn(async (opts: any) => ({
        id: Math.floor(Math.random() * 10000),
        index: 0,
        title: 'New Tab',
        url: opts?.url || 'about:blank',
        ...opts,
      })),
      update: vi.fn(async () => ({})),
      remove: vi.fn(async () => {}),
      goBack: vi.fn(async () => {}),
      get: vi.fn(async (tabId: number) => ({
        id: tabId,
        index: 0,
        title: 'Test Tab',
        url: 'https://example.com',
        windowId: 1,
      })),
      onUpdated: makeEvent(),
      onRemoved: makeEvent(),
      onActivated: makeEvent(),
    },

    storage: {
      local: {
        get: vi.fn(async (keys: string[]) => {
          const result: Record<string, any> = {};
          for (const key of keys) {
            if (key in storage) result[key] = storage[key];
          }
          return result;
        }),
        set: vi.fn(async (items: Record<string, any>) => {
          Object.assign(storage, items);
        }),
      },
      session: {
        get: vi.fn(async (key: string) => ({ [key]: storage[`__session_${key}`] })),
        set: vi.fn(async (items: Record<string, any>) => {
          for (const [k, v] of Object.entries(items)) storage[`__session_${k}`] = v;
        }),
        remove: vi.fn(async (key: string) => { delete storage[`__session_${key}`]; }),
      },
      onChanged: makeEvent(),
      _data: storage,
    },

    runtime: {
      getManifest: vi.fn(() => ({
        name: 'SuperSurf',
        version: '0.1.0',
      })),
      sendMessage: vi.fn(),
      onMessage: makeEvent(),
    },

    scripting: {
      executeScript: vi.fn(async () => [{ result: undefined }]),
    },

    action: {
      setBadgeText: vi.fn(async () => {}),
      setBadgeBackgroundColor: vi.fn(async () => {}),
      setTitle: vi.fn(async () => {}),
      setIcon: vi.fn(async () => {}),
    },

    management: {
      getAll: vi.fn(async () => []),
      setEnabled: vi.fn(async () => {}),
    },

    alarms: {
      create: vi.fn(),
      clear: vi.fn(),
      onAlarm: makeEvent(),
    },

    webNavigation: {
      onBeforeNavigate: makeEvent(),
      onCommitted: makeEvent(),
      onCompleted: makeEvent(),
    },

    webRequest: {
      onBeforeRequest: makeEvent(),
      onBeforeSendHeaders: makeEvent(),
      onCompleted: makeEvent(),
      onErrorOccurred: makeEvent(),
    },

    tabGroups: {
      update: vi.fn(async () => ({})),
      onRemoved: makeEvent(),
    },

    windows: {
      update: vi.fn(async () => ({})),
      remove: vi.fn(async () => {}),
    },
  } as any;
}
