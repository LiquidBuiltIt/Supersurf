import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockChrome } from '../__mocks__/chrome';
import { DialogHandler } from '../../src/handlers/dialogs';

function createMockLogger() {
  return {
    log: vi.fn(),
    logAlways: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    setDebugMode: vi.fn(),
  } as any;
}

describe('DialogHandler', () => {
  let mockChrome: ReturnType<typeof createMockChrome>;
  let mockLogger: ReturnType<typeof createMockLogger>;
  let handler: DialogHandler;

  beforeEach(() => {
    mockChrome = createMockChrome();
    mockLogger = createMockLogger();
    handler = new DialogHandler(mockChrome, mockLogger);
  });

  describe('setupDialogOverrides()', () => {
    it('calls chrome.scripting.executeScript with correct target and world', async () => {
      await handler.setupDialogOverrides(42);

      expect(mockChrome.scripting.executeScript).toHaveBeenCalledTimes(1);
      const callArg = mockChrome.scripting.executeScript.mock.calls[0][0];
      expect(callArg.target).toEqual({ tabId: 42 });
      expect(callArg.world).toBe('MAIN');
      expect(typeof callArg.func).toBe('function');
    });

    it('passes accept=false and empty promptText as default args', async () => {
      await handler.setupDialogOverrides(42);

      const callArg = mockChrome.scripting.executeScript.mock.calls[0][0];
      expect(callArg.args).toEqual([false, '']);
    });

    it('passes custom accept and promptText args', async () => {
      await handler.setupDialogOverrides(42, false, 'custom text');

      const callArg = mockChrome.scripting.executeScript.mock.calls[0][0];
      expect(callArg.args).toEqual([false, 'custom text']);
    });

    it('logs and propagates injection errors', async () => {
      mockChrome.scripting.executeScript.mockRejectedValueOnce(new Error('Cannot inject'));

      await expect(handler.setupDialogOverrides(42)).rejects.toThrow(/Cannot inject/);
      expect(mockLogger.log).toHaveBeenCalled();
    });
  });

  describe('getDialogEvents()', () => {
    it('calls chrome.scripting.executeScript with correct target', async () => {
      await handler.getDialogEvents(42);

      expect(mockChrome.scripting.executeScript).toHaveBeenCalledTimes(1);
      const callArg = mockChrome.scripting.executeScript.mock.calls[0][0];
      expect(callArg.target).toEqual({ tabId: 42 });
      expect(callArg.world).toBe('MAIN');
    });

    it('returns the result from executeScript', async () => {
      const mockEvents = [
        { type: 'alert', message: 'Hello', response: 'accepted', timestamp: 1000 },
      ];
      mockChrome.scripting.executeScript.mockResolvedValueOnce([{ result: mockEvents }]);

      const events = await handler.getDialogEvents(42);
      expect(events).toEqual(mockEvents);
    });

    it('returns empty array when no events exist', async () => {
      mockChrome.scripting.executeScript.mockResolvedValueOnce([{ result: [] }]);

      const events = await handler.getDialogEvents(42);
      expect(events).toEqual([]);
    });

    it('returns empty array when executeScript returns null result', async () => {
      mockChrome.scripting.executeScript.mockResolvedValueOnce([{ result: null }]);

      const events = await handler.getDialogEvents(42);
      expect(events).toEqual([]);
    });

    it('returns empty array when executeScript returns undefined', async () => {
      mockChrome.scripting.executeScript.mockResolvedValueOnce(undefined);

      const events = await handler.getDialogEvents(42);
      expect(events).toEqual([]);
    });

    it('returns empty array on failure', async () => {
      mockChrome.scripting.executeScript.mockRejectedValueOnce(new Error('Tab gone'));

      const events = await handler.getDialogEvents(42);
      expect(events).toEqual([]);
    });
  });

  describe('clearDialogEvents()', () => {
    it('calls chrome.scripting.executeScript with correct target', async () => {
      await handler.clearDialogEvents(42);

      expect(mockChrome.scripting.executeScript).toHaveBeenCalledTimes(1);
      const callArg = mockChrome.scripting.executeScript.mock.calls[0][0];
      expect(callArg.target).toEqual({ tabId: 42 });
      expect(callArg.world).toBe('MAIN');
    });

    it('handles errors gracefully', async () => {
      mockChrome.scripting.executeScript.mockRejectedValueOnce(new Error('Tab gone'));

      // Should not throw
      await handler.clearDialogEvents(42);
    });
  });
});

describe('DialogHandler.dismissNativeDialog', () => {
  let chromeMock: any;
  let logger: any;
  let handler: DialogHandler;

  beforeEach(() => {
    chromeMock = {
      debugger: {
        sendCommand: vi.fn().mockResolvedValue(undefined),
      },
      scripting: { executeScript: vi.fn().mockResolvedValue([{ result: [] }]) },
    };
    logger = { log: vi.fn(), logAlways: vi.fn() };
    handler = new DialogHandler(chromeMock, logger);
  });

  it('fires Page.handleJavaScriptDialog with accept=true and promptText', async () => {
    await handler.dismissNativeDialog(42, true, 'hello');
    expect(chromeMock.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 42 },
      'Page.handleJavaScriptDialog',
      { accept: true, promptText: 'hello' }
    );
  });

  it('swallows "No dialog is showing" CDP errors silently', async () => {
    chromeMock.debugger.sendCommand.mockRejectedValueOnce(
      new Error('No dialog is showing.')
    );
    await expect(handler.dismissNativeDialog(42, true, '')).resolves.toBeUndefined();
  });

  it('propagates non-"No dialog" CDP errors', async () => {
    chromeMock.debugger.sendCommand.mockRejectedValueOnce(
      new Error('Debugger is not attached to this tab.')
    );
    await expect(handler.dismissNativeDialog(42, true, '')).rejects.toThrow(/not attached/);
  });

  it('propagates errors that incidentally contain the words "no dialog"', async () => {
    chromeMock.debugger.sendCommand.mockRejectedValueOnce(
      new Error('Frame has no dialog handler attached')
    );
    await expect(handler.dismissNativeDialog(42, true, '')).rejects.toThrow(/no dialog handler/);
  });
});

describe('DialogHandler.handleDialogCommand', () => {
  let chromeMock: any;
  let logger: any;
  let handler: DialogHandler;

  beforeEach(() => {
    chromeMock = {
      debugger: { sendCommand: vi.fn().mockResolvedValue(undefined) },
      scripting: {
        executeScript: vi.fn().mockResolvedValue([{
          result: [{ type: 'alert', message: 'hi', response: 'accepted', timestamp: 1 }],
        }]),
      },
    };
    logger = { log: vi.fn(), logAlways: vi.fn() };
    handler = new DialogHandler(chromeMock, logger);
  });

  it('with accept=true: dismisses native dialog via CDP, re-injects stubs, returns events', async () => {
    const result = await handler.handleDialogCommand(7, { accept: true, text: 'yo' });
    expect(chromeMock.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 7 },
      'Page.handleJavaScriptDialog',
      { accept: true, promptText: 'yo' }
    );
    expect(chromeMock.scripting.executeScript).toHaveBeenCalled();
    expect(result.events).toHaveLength(1);
  });

  it('with no accept: skips CDP, just returns events', async () => {
    const result = await handler.handleDialogCommand(7, {});
    expect(chromeMock.debugger.sendCommand).not.toHaveBeenCalled();
    expect(result.events).toHaveLength(1);
    expect(chromeMock.scripting.executeScript).toHaveBeenCalledTimes(1);
  });
});

describe('DialogHandler.drainDialogEvents (atomic read-and-clear)', () => {
  it('reads-and-clears in a single executeScript call (no race)', async () => {
    const chromeMock = {
      scripting: {
        executeScript: vi.fn().mockResolvedValue([{
          result: [{ type: 'alert', message: 'hi', response: 'accepted', timestamp: 1 }],
        }]),
      },
    };
    const logger = { log: vi.fn(), logAlways: vi.fn() };
    const handler = new DialogHandler(chromeMock as any, logger as any);

    const events = await handler.drainDialogEvents(42);

    expect(events).toEqual([{ type: 'alert', message: 'hi', response: 'accepted', timestamp: 1 }]);
    expect(chromeMock.scripting.executeScript).toHaveBeenCalledTimes(1);
    const fn = chromeMock.scripting.executeScript.mock.calls[0][0].func.toString();
    expect(fn).toMatch(/__supersurfDialogEvents/);
    expect(fn).toMatch(/=\s*\[\]/);
  });

  it('returns empty array on injection failure', async () => {
    const chromeMock = {
      scripting: {
        executeScript: vi.fn().mockRejectedValue(new Error('tab navigating')),
      },
    };
    const logger = { log: vi.fn(), logAlways: vi.fn() };
    const handler = new DialogHandler(chromeMock as any, logger as any);

    const events = await handler.drainDialogEvents(42);
    expect(events).toEqual([]);
  });
});

describe('DialogHandler default accept value', () => {
  it('setupDialogOverrides defaults accept to false', async () => {
    const chromeMock = {
      scripting: { executeScript: vi.fn().mockResolvedValue([{ result: undefined }]) },
    };
    const logger = { log: vi.fn(), logAlways: vi.fn() };
    const handler = new DialogHandler(chromeMock as any, logger as any);

    await handler.setupDialogOverrides(1);

    const call = chromeMock.scripting.executeScript.mock.calls[0][0];
    expect(call.args).toEqual([false, '']);
  });
});

describe('DialogHandler buffering', () => {
  it('consumeBufferedEvents returns and clears buffered events', async () => {
    const chromeMock = {
      scripting: {
        executeScript: vi.fn()
          .mockResolvedValueOnce([{ result: [{ type: 'alert', message: 'a', timestamp: 1 }] }])
          .mockResolvedValue([{ result: undefined }]),
      },
    };
    const logger = { log: vi.fn(), logAlways: vi.fn() };
    const handler = new DialogHandler(chromeMock as any, logger as any);

    vi.useFakeTimers();
    handler.startBuffering(5);
    await vi.advanceTimersByTimeAsync(600);
    vi.useRealTimers();

    expect(handler.consumeBufferedEvents()).toEqual([
      { type: 'alert', message: 'a', timestamp: 1 },
    ]);
    expect(handler.consumeBufferedEvents()).toEqual([]);
    handler.stopBuffering();
  });

  it('startBuffering is idempotent (calling twice does not start two intervals)', () => {
    const chromeMock = {
      scripting: { executeScript: vi.fn().mockResolvedValue([{ result: [] }]) },
    };
    const logger = { log: vi.fn(), logAlways: vi.fn() };
    const handler = new DialogHandler(chromeMock as any, logger as any);

    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    handler.startBuffering(1);
    handler.startBuffering(1);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    setIntervalSpy.mockRestore();
    handler.stopBuffering();
    vi.useRealTimers();
  });

  it('re-calling startBuffering with a new tabId swaps drain target without restarting the interval', async () => {
    const chromeMock = {
      scripting: { executeScript: vi.fn().mockResolvedValue([{ result: [] }]) },
    };
    const logger = { log: vi.fn(), logAlways: vi.fn() };
    const handler = new DialogHandler(chromeMock as any, logger as any);

    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    handler.startBuffering(5);
    handler.startBuffering(7);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(600);

    // Verify the drain pulled from tabId 7 (the most-recent value)
    const targets = chromeMock.scripting.executeScript.mock.calls.map(
      (c: any[]) => c[0].target.tabId
    );
    expect(targets).toContain(7);
    expect(targets).not.toContain(5);

    setIntervalSpy.mockRestore();
    handler.stopBuffering();
    vi.useRealTimers();
  });

  it('stopBuffering is safe to call when not buffering', () => {
    const chromeMock = {
      scripting: { executeScript: vi.fn().mockResolvedValue([{ result: [] }]) },
    };
    const logger = { log: vi.fn(), logAlways: vi.fn() };
    const handler = new DialogHandler(chromeMock as any, logger as any);

    // Should not throw
    expect(() => handler.stopBuffering()).not.toThrow();
  });
});

describe('DialogHandler.setupDialogOverrides error handling', () => {
  let chromeMock: any;
  let logger: any;
  let handler: DialogHandler;

  beforeEach(() => {
    chromeMock = {
      scripting: { executeScript: vi.fn() },
    };
    logger = { log: vi.fn(), logAlways: vi.fn() };
    handler = new DialogHandler(chromeMock, logger);
  });

  it('throws when MAIN-world injection fails', async () => {
    chromeMock.scripting.executeScript.mockRejectedValueOnce(
      new Error('Cannot access a chrome:// URL')
    );
    await expect(handler.setupDialogOverrides(99, true, '')).rejects.toThrow(/chrome:/);
  });
});
