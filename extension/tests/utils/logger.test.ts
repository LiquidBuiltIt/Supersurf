import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockChrome } from '../__mocks__/chrome';
import { Logger } from '../../src/utils/logger';

describe('Logger', () => {
  let logger: Logger;
  let mockChrome: ReturnType<typeof createMockChrome>;
  let consoleSpy: {
    log: ReturnType<typeof vi.spyOn>;
    error: ReturnType<typeof vi.spyOn>;
    warn: ReturnType<typeof vi.spyOn>;
  };

  beforeEach(() => {
    mockChrome = createMockChrome();
    logger = new Logger('TestPrefix');

    consoleSpy = {
      log: vi.spyOn(console, 'log').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('constructor sets the prefix', () => {
    // The prefix is private, but we can verify it appears in log output
    logger.setDebugMode(true);
    logger.log('hello');
    expect(consoleSpy.log).toHaveBeenCalledTimes(1);
    const firstArg = consoleSpy.log.mock.calls[0][0] as string;
    expect(firstArg).toContain('[TestPrefix]');
  });

  describe('init()', () => {
    it('reads debugMode from chrome.storage.local', async () => {
      mockChrome.storage.local.get.mockResolvedValueOnce({ debugMode: true });
      await logger.init(mockChrome);

      expect(mockChrome.storage.local.get).toHaveBeenCalledWith(['debugMode']);
    });

    it('sets debug mode to true when storage returns debugMode=true', async () => {
      mockChrome.storage.local.get.mockResolvedValueOnce({ debugMode: true });
      await logger.init(mockChrome);

      logger.log('should appear');
      expect(consoleSpy.log).toHaveBeenCalled();
    });

    it('sets debug mode to false when storage returns debugMode=false', async () => {
      mockChrome.storage.local.get.mockResolvedValueOnce({ debugMode: false });
      await logger.init(mockChrome);

      logger.log('should not appear');
      expect(consoleSpy.log).not.toHaveBeenCalled();
    });

    it('sets debug mode to false when storage has no debugMode key', async () => {
      mockChrome.storage.local.get.mockResolvedValueOnce({});
      await logger.init(mockChrome);

      logger.log('should not appear');
      expect(consoleSpy.log).not.toHaveBeenCalled();
    });

    it('registers a storage change listener', async () => {
      mockChrome.storage.local.get.mockResolvedValueOnce({});
      await logger.init(mockChrome);

      expect(mockChrome.storage.onChanged.addListener).toHaveBeenCalledTimes(1);
    });
  });

  describe('log()', () => {
    it('outputs when debug mode is on', () => {
      logger.setDebugMode(true);
      logger.log('test message');

      expect(consoleSpy.log).toHaveBeenCalledTimes(1);
      expect(consoleSpy.log.mock.calls[0][1]).toBe('test message');
    });

    it('is silent when debug mode is off', () => {
      logger.setDebugMode(false);
      logger.log('test message');

      expect(consoleSpy.log).not.toHaveBeenCalled();
    });

    it('passes multiple arguments', () => {
      logger.setDebugMode(true);
      logger.log('a', 'b', 'c');

      expect(consoleSpy.log).toHaveBeenCalledTimes(1);
      const args = consoleSpy.log.mock.calls[0];
      expect(args[1]).toBe('a');
      expect(args[2]).toBe('b');
      expect(args[3]).toBe('c');
    });

    it('includes a timestamp in the prefix', () => {
      logger.setDebugMode(true);
      logger.log('timed');

      const firstArg = consoleSpy.log.mock.calls[0][0] as string;
      // Timestamp format: HH:MM:SS.mmm
      expect(firstArg).toMatch(/\[\w+\]\s+\d{2}:\d{2}:\d{2}\.\d{3}/);
    });
  });

  describe('logAlways()', () => {
    it('always outputs regardless of debug mode being off', () => {
      logger.setDebugMode(false);
      logger.logAlways('always visible');

      expect(consoleSpy.log).toHaveBeenCalledTimes(1);
      expect(consoleSpy.log.mock.calls[0][1]).toBe('always visible');
    });

    it('always outputs when debug mode is on', () => {
      logger.setDebugMode(true);
      logger.logAlways('also visible');

      expect(consoleSpy.log).toHaveBeenCalledTimes(1);
    });

    it('includes the prefix', () => {
      logger.logAlways('prefixed');
      const firstArg = consoleSpy.log.mock.calls[0][0] as string;
      expect(firstArg).toContain('[TestPrefix]');
    });
  });

  describe('error()', () => {
    it('always outputs to console.error', () => {
      logger.setDebugMode(false);
      logger.error('an error');

      expect(consoleSpy.error).toHaveBeenCalledTimes(1);
      expect(consoleSpy.error.mock.calls[0][1]).toBe('an error');
    });

    it('includes the prefix', () => {
      logger.error('oops');
      const firstArg = consoleSpy.error.mock.calls[0][0] as string;
      expect(firstArg).toContain('[TestPrefix]');
    });
  });

  describe('warn()', () => {
    it('always outputs to console.warn', () => {
      logger.setDebugMode(false);
      logger.warn('a warning');

      expect(consoleSpy.warn).toHaveBeenCalledTimes(1);
      expect(consoleSpy.warn.mock.calls[0][1]).toBe('a warning');
    });

    it('includes the prefix', () => {
      logger.warn('caution');
      const firstArg = consoleSpy.warn.mock.calls[0][0] as string;
      expect(firstArg).toContain('[TestPrefix]');
    });
  });

  describe('setDebugMode()', () => {
    it('enables debug logging when set to true', () => {
      logger.setDebugMode(false);
      logger.log('invisible');
      expect(consoleSpy.log).not.toHaveBeenCalled();

      logger.setDebugMode(true);
      logger.log('visible');
      expect(consoleSpy.log).toHaveBeenCalledTimes(1);
    });

    it('disables debug logging when set to false', () => {
      logger.setDebugMode(true);
      logger.log('visible');
      expect(consoleSpy.log).toHaveBeenCalledTimes(1);

      logger.setDebugMode(false);
      logger.log('invisible');
      expect(consoleSpy.log).toHaveBeenCalledTimes(1); // still 1
    });
  });

  describe('storage change listener', () => {
    it('updates debug mode when storage changes to true', async () => {
      mockChrome.storage.local.get.mockResolvedValueOnce({ debugMode: false });
      await logger.init(mockChrome);

      // Debug should be off
      logger.log('hidden');
      expect(consoleSpy.log).not.toHaveBeenCalled();

      // Fire storage change event
      mockChrome.storage.onChanged._fire(
        { debugMode: { newValue: true, oldValue: false } },
        'local'
      );

      logger.log('now visible');
      expect(consoleSpy.log).toHaveBeenCalledTimes(1);
    });

    it('updates debug mode when storage changes to false', async () => {
      mockChrome.storage.local.get.mockResolvedValueOnce({ debugMode: true });
      await logger.init(mockChrome);

      logger.log('visible');
      expect(consoleSpy.log).toHaveBeenCalledTimes(1);

      mockChrome.storage.onChanged._fire(
        { debugMode: { newValue: false, oldValue: true } },
        'local'
      );

      logger.log('hidden');
      expect(consoleSpy.log).toHaveBeenCalledTimes(1); // still 1
    });

    it('ignores storage changes from non-local areas', async () => {
      mockChrome.storage.local.get.mockResolvedValueOnce({ debugMode: false });
      await logger.init(mockChrome);

      mockChrome.storage.onChanged._fire(
        { debugMode: { newValue: true, oldValue: false } },
        'sync'
      );

      logger.log('should still be hidden');
      expect(consoleSpy.log).not.toHaveBeenCalled();
    });

    it('ignores storage changes for unrelated keys', async () => {
      mockChrome.storage.local.get.mockResolvedValueOnce({ debugMode: false });
      await logger.init(mockChrome);

      mockChrome.storage.onChanged._fire(
        { someOtherKey: { newValue: 'foo' } },
        'local'
      );

      logger.log('should still be hidden');
      expect(consoleSpy.log).not.toHaveBeenCalled();
    });
  });

  describe('secure_fill redaction', () => {
    const msg = { jsonrpc: '2.0', id: 1, method: 'secure_fill', params: { selector: '#pw', value: 'hunter2-SECRET', tabId: 3 } };

    it('never prints the secure_fill credential value', () => {
      logger.setDebugMode(true);
      logger.log('[WebSocket] Received:', msg);
      logger.logAlways('x', msg);
      logger.error('x', msg);
      logger.warn('x', msg);
      const printed = JSON.stringify([consoleSpy.log.mock.calls, consoleSpy.error.mock.calls, consoleSpy.warn.mock.calls]);
      expect(printed).not.toContain('hunter2-SECRET');
      expect(printed).toContain('#pw');
    });

    it('does not redact value on other commands and does not mutate the message', () => {
      logger.setDebugMode(true);
      logger.log('other', { method: 'forwardCDPCommand', params: { value: 'visible-value' } });
      expect(JSON.stringify(consoleSpy.log.mock.calls)).toContain('visible-value');
      logger.log(msg);
      expect(msg.params.value).toBe('hunter2-SECRET');
    });
  });
});
