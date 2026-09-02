import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { LoggerRegistry } from '../logger/registry';
import { FileLogger } from '../logger/logger';

describe('FileLogger', () => {
  let tempDir: string;
  let logPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supersurf-logger-test-'));
    logPath = path.join(tempDir, 'test-debug.log');
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('constructor', () => {
    it('creates log directory if missing', () => {
      const nestedDir = path.join(tempDir, 'nested', 'deep');
      const nestedLogPath = path.join(nestedDir, 'debug.log');

      new FileLogger(nestedLogPath);

      expect(fs.existsSync(nestedDir)).toBe(true);
    });

    it('truncates existing log file', () => {
      fs.writeFileSync(logPath, 'old log content\nmore old stuff\n');
      expect(fs.readFileSync(logPath, 'utf8')).toContain('old log content');

      new FileLogger(logPath);

      const content = fs.readFileSync(logPath, 'utf8');
      expect(content).toBe('');
    });

    it('works when log file does not exist yet', () => {
      expect(fs.existsSync(logPath)).toBe(false);
      const logger = new FileLogger(logPath);
      expect(logger.logFilePath).toBe(logPath);
    });

    it('stores the log file path', () => {
      const logger = new FileLogger(logPath);
      expect(logger.logFilePath).toBe(logPath);
    });
  });

  describe('enabled state', () => {
    it('starts disabled', () => {
      const logger = new FileLogger(logPath);
      expect(logger.enabled).toBe(false);
    });

    it('enable() sets enabled to true', () => {
      const logger = new FileLogger(logPath);
      logger.enable();
      expect(logger.enabled).toBe(true);
    });

    it('disable() sets enabled to false', () => {
      const logger = new FileLogger(logPath);
      logger.enable();
      logger.disable();
      expect(logger.enabled).toBe(false);
    });
  });

  describe('log()', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleErrorSpy.mockRestore();
    });

    it('writes to file when enabled', () => {
      const logger = new FileLogger(logPath);
      logger.enable();
      logger.log('test message');

      const content = fs.readFileSync(logPath, 'utf8');
      expect(content).toContain('test message');
    });

    it('does nothing when disabled', () => {
      const logger = new FileLogger(logPath);
      logger.log('should not appear');

      if (fs.existsSync(logPath)) {
        const content = fs.readFileSync(logPath, 'utf8');
        expect(content).not.toContain('should not appear');
      }
    });

    it('writes timestamp prefix', () => {
      const logger = new FileLogger(logPath);
      logger.enable();
      logger.log('timestamp test');

      const content = fs.readFileSync(logPath, 'utf8');
      expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('also writes to console.error', () => {
      const logger = new FileLogger(logPath);
      logger.enable();
      logger.log('stderr test');

      expect(consoleErrorSpy).toHaveBeenCalledWith('stderr test');
    });

    it('handles multiple arguments', () => {
      const logger = new FileLogger(logPath);
      logger.enable();
      logger.log('part1', 'part2', 'part3');

      const content = fs.readFileSync(logPath, 'utf8');
      expect(content).toContain('part1 part2 part3');
    });

    it('serializes objects as JSON', () => {
      const logger = new FileLogger(logPath);
      logger.truncate = false;
      logger.enable();
      logger.log('object:', { key: 'value', nested: { a: 1 } });

      const content = fs.readFileSync(logPath, 'utf8');
      expect(content).toContain('"key": "value"');
      expect(content).toContain('"a": 1');
    });

    it('handles non-serializable objects gracefully', () => {
      const logger = new FileLogger(logPath);
      logger.enable();

      const circular: any = {};
      circular.self = circular;
      logger.log('circular:', circular);

      const content = fs.readFileSync(logPath, 'utf8');
      expect(content).toContain('circular:');
    });

    it('appends multiple log lines', () => {
      const logger = new FileLogger(logPath);
      logger.enable();
      logger.log('line one');
      logger.log('line two');
      logger.log('line three');

      const content = fs.readFileSync(logPath, 'utf8');
      expect(content).toContain('line one');
      expect(content).toContain('line two');
      expect(content).toContain('line three');
    });

    it('enable() writes its own log message', () => {
      const logger = new FileLogger(logPath);
      logger.enable();

      const content = fs.readFileSync(logPath, 'utf8');
      expect(content).toContain('Logging enabled');
    });
  });

  describe('truncation', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleErrorSpy.mockRestore();
    });

    it('defaults to truncation enabled', () => {
      const logger = new FileLogger(logPath);
      expect(logger.truncate).toBe(true);
    });

    it('truncates long strings when truncation is on', () => {
      const logger = new FileLogger(logPath);
      logger.enable();
      const longStr = 'x'.repeat(300);
      logger.log(longStr);

      const content = fs.readFileSync(logPath, 'utf8');
      expect(content).toContain('...');
      expect(content.length).toBeLessThan(longStr.length + 100);
    });

    it('does not truncate when truncation is off', () => {
      const logger = new FileLogger(logPath);
      logger.truncate = false;
      logger.enable();
      const longStr = 'x'.repeat(300);
      logger.log(longStr);

      const content = fs.readFileSync(logPath, 'utf8');
      expect(content).toContain(longStr);
    });

    it('redacts base64 data in objects', () => {
      const logger = new FileLogger(logPath);
      logger.enable();
      const fakeBase64 = 'A'.repeat(500);
      logger.log({ data: fakeBase64 });

      const content = fs.readFileSync(logPath, 'utf8');
      expect(content).toContain('[base64 500 chars]');
      expect(content).not.toContain(fakeBase64);
    });

    it('does not redact short strings that look like base64', () => {
      const logger = new FileLogger(logPath);
      logger.truncate = false;
      logger.enable();
      logger.log({ data: 'ABC123' });

      const content = fs.readFileSync(logPath, 'utf8');
      expect(content).toContain('ABC123');
    });
  });

  describe('getLogger() singleton', () => {
    it('returns a FileLogger instance', async () => {
      const customPath = path.join(tempDir, 'singleton-test.log');

      vi.resetModules();
      const { getLogger } = await import('../logger/registry');

      const logger = getLogger(customPath);
      expect(logger).toBeDefined();
      expect(logger.logFilePath).toBe(customPath);
    });

    it('returns the same instance on subsequent calls', async () => {
      const customPath = path.join(tempDir, 'singleton-same.log');

      vi.resetModules();
      const { getLogger } = await import('../logger/registry');

      const logger1 = getLogger(customPath);
      const logger2 = getLogger();

      expect(logger1).toBe(logger2);
    });
  });
});

describe('LoggerRegistry', () => {
  let tempDir: string;
  let registry: LoggerRegistry;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supersurf-registry-test-'));
    registry = new LoggerRegistry();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    registry.reset();
    consoleErrorSpy.mockRestore();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe('debugMode', () => {
    it('defaults to false', () => {
      expect(registry.debugMode).toBe(false);
    });

    it('can be set to truncate', () => {
      registry.debugMode = 'truncate';
      expect(registry.debugMode).toBe('truncate');
    });

    it('can be set to no_truncate', () => {
      registry.debugMode = 'no_truncate';
      expect(registry.debugMode).toBe('no_truncate');
    });

    it('propagates truncation=true for truncate mode', () => {
      const serverLog = path.join(tempDir, 'server.log');
      const logger = registry.getServerLogger(serverLog);
      registry.debugMode = 'truncate';
      expect(logger.truncate).toBe(true);
    });

    it('propagates truncation=false for no_truncate mode', () => {
      const serverLog = path.join(tempDir, 'server.log');
      const logger = registry.getServerLogger(serverLog);
      registry.debugMode = 'no_truncate';
      expect(logger.truncate).toBe(false);
    });
  });

  describe('server logger', () => {
    it('creates server logger with custom path', () => {
      const serverLog = path.join(tempDir, 'server.log');
      const logger = registry.getServerLogger(serverLog);
      expect(logger.logFilePath).toBe(serverLog);
    });

    it('returns same instance on subsequent calls', () => {
      const serverLog = path.join(tempDir, 'server.log');
      const logger1 = registry.getServerLogger(serverLog);
      const logger2 = registry.getServerLogger();
      expect(logger1).toBe(logger2);
    });
  });

  describe('session logs', () => {
    it('creates session log file', () => {
      registry.debugMode = 'truncate';
      const sessionLogger = registry.setSessionLog('my-project');
      expect(sessionLogger.logFilePath).toContain('my-project');
      expect(sessionLogger.enabled).toBe(true);
    });

    it('does not enable session logger when debug is off', () => {
      registry.debugMode = false;
      const sessionLogger = registry.setSessionLog('my-project');
      expect(sessionLogger.enabled).toBe(false);
    });

    it('routes getLogger to session when available', () => {
      const serverLog = path.join(tempDir, 'server.log');
      registry.getServerLogger(serverLog);
      registry.debugMode = 'truncate';
      const sessionLogger = registry.setSessionLog('test-session');
      const resolved = registry.getLogger('test-session');
      expect(resolved).toBe(sessionLogger);
    });

    it('falls back to server logger when session not found', () => {
      const serverLog = path.join(tempDir, 'server.log');
      const serverLogger = registry.getServerLogger(serverLog);
      const resolved = registry.getLogger('nonexistent');
      expect(resolved).toBe(serverLogger);
    });

    it('falls back to server logger when sessionId is null', () => {
      const serverLog = path.join(tempDir, 'server.log');
      const serverLogger = registry.getServerLogger(serverLog);
      const resolved = registry.getLogger(null);
      expect(resolved).toBe(serverLogger);
    });

    it('clearSessionLog disables and removes logger', () => {
      registry.debugMode = 'truncate';
      const sessionLogger = registry.setSessionLog('ephemeral');
      expect(sessionLogger.enabled).toBe(true);

      registry.clearSessionLog('ephemeral');
      expect(sessionLogger.enabled).toBe(false);

      // Should now fall back to server
      const serverLog = path.join(tempDir, 'server.log');
      registry.getServerLogger(serverLog);
      const resolved = registry.getLogger('ephemeral');
      expect(resolved.logFilePath).toBe(serverLog);
    });

    it('setSessionLog cleans up previous session with same id', () => {
      registry.debugMode = 'truncate';
      const first = registry.setSessionLog('reuse-id');
      expect(first.enabled).toBe(true);

      const second = registry.setSessionLog('reuse-id');
      expect(first.enabled).toBe(false); // old one disabled
      expect(second.enabled).toBe(true);
      expect(second).not.toBe(first);
    });

    it('sanitizes session id for filename', () => {
      registry.debugMode = 'truncate';
      const sessionLogger = registry.setSessionLog('my project/with spaces!');
      expect(sessionLogger.logFilePath).toContain('my_project_with_spaces_');
      expect(sessionLogger.logFilePath).not.toContain(' ');
      expect(sessionLogger.logFilePath).not.toContain('/with');
    });

    it('propagates truncation setting to session loggers', () => {
      registry.debugMode = 'no_truncate';
      const sessionLogger = registry.setSessionLog('no-trunc');
      expect(sessionLogger.truncate).toBe(false);
    });
  });

  describe('reset', () => {
    it('clears all state', () => {
      const serverLog = path.join(tempDir, 'server.log');
      registry.getServerLogger(serverLog);
      registry.debugMode = 'truncate';
      registry.setSessionLog('test');

      registry.reset();

      expect(registry.debugMode).toBe(false);
    });
  });
});
