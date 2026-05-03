import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { AuditLogger, redactParams } from '../src/audit-logger';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supersurf-audit-test-'));
});

afterEach(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

describe('redactParams', () => {
  it('redacts sensitive fields', () => {
    const result = redactParams({
      selector: '#login',
      value: 'my-password-123',
      password: 'secret',
      token: 'abc-123',
    });

    expect(result.selector).toBe('#login');
    expect(result.value).toBe('[REDACTED]');
    expect(result.password).toBe('[REDACTED]');
    expect(result.token).toBe('[REDACTED]');
  });

  it('redacts case-insensitively', () => {
    const result = redactParams({ Password: 'foo', TOKEN: 'bar' });
    expect(result.Password).toBe('[REDACTED]');
    expect(result.TOKEN).toBe('[REDACTED]');
  });

  it('passes through non-sensitive fields unchanged', () => {
    const result = redactParams({
      selector: 'button.submit',
      action: 'click',
      coordinate: '100,200',
    });

    expect(result.selector).toBe('button.submit');
    expect(result.action).toBe('click');
    expect(result.coordinate).toBe('100,200');
  });

  it('strips data fields entirely', () => {
    const result = redactParams({
      format: 'jpeg',
      data: 'aVeryLongBase64String...',
      quality: 80,
    });

    expect(result.format).toBe('jpeg');
    expect(result.quality).toBe(80);
    expect(result).not.toHaveProperty('data');
  });

  it('handles empty params', () => {
    expect(redactParams({})).toEqual({});
  });
});

describe('AuditLogger', () => {
  it('creates audit file in the correct directory', () => {
    const logger = new AuditLogger('test-session', tempDir);
    const logPath = logger.getPath();

    expect(logPath).toContain(tempDir);
    expect(logPath).toContain('audit-test-session-');
    expect(logPath).toMatch(/\.ndjson$/);
  });

  it('sanitizes session ID in filename', () => {
    const logger = new AuditLogger('bad/session:name.here', tempDir);
    const logPath = logger.getPath();

    expect(path.basename(logPath)).not.toContain('/');
    expect(path.basename(logPath)).not.toContain(':');
    expect(logPath).toContain('audit-bad_session_name_here-');
  });

  it('writes valid JSON lines', () => {
    const logger = new AuditLogger('json-test', tempDir);

    logger.write({
      session_id: 'json-test',
      tool: 'browser_navigate',
      params: { url: 'https://example.com' },
      result: 'ok',
      duration_ms: 150,
    });

    logger.write({
      session_id: 'json-test',
      tool: 'browser_interact',
      params: { action: 'click', selector: '#btn' },
      result: 'ok',
      url: 'https://example.com',
      duration_ms: 42,
    });

    const content = fs.readFileSync(logger.getPath(), 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);

    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty('ts');
      expect(parsed).toHaveProperty('session_id');
      expect(parsed).toHaveProperty('tool');
      expect(parsed).toHaveProperty('params');
      expect(parsed).toHaveProperty('result');
      expect(parsed).toHaveProperty('duration_ms');
    }
  });

  it('includes ISO timestamp', () => {
    const logger = new AuditLogger('ts-test', tempDir);

    logger.write({
      session_id: 'ts-test',
      tool: 'browser_snapshot',
      params: {},
      result: 'ok',
      duration_ms: 10,
    });

    const content = fs.readFileSync(logger.getPath(), 'utf8');
    const entry = JSON.parse(content.trim());
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('logs error result with error message', () => {
    const logger = new AuditLogger('error-test', tempDir);

    logger.write({
      session_id: 'error-test',
      tool: 'browser_evaluate',
      params: { expression: 'bad()' },
      result: 'error',
      error: 'ReferenceError: bad is not defined',
      duration_ms: 5,
    });

    const content = fs.readFileSync(logger.getPath(), 'utf8');
    const entry = JSON.parse(content.trim());
    expect(entry.result).toBe('error');
    expect(entry.error).toBe('ReferenceError: bad is not defined');
  });

  it('redacts sensitive fields in written entries', () => {
    const logger = new AuditLogger('redact-test', tempDir);

    logger.write({
      session_id: 'redact-test',
      tool: 'secure_fill',
      params: { selector: '#password', value: 'super-secret-123' },
      result: 'ok',
      duration_ms: 200,
    });

    const content = fs.readFileSync(logger.getPath(), 'utf8');
    const entry = JSON.parse(content.trim());
    expect(entry.params.selector).toBe('#password');
    expect(entry.params.value).toBe('[REDACTED]');
    expect(content).not.toContain('super-secret-123');
  });

  it('strips data fields from written entries', () => {
    const logger = new AuditLogger('strip-test', tempDir);

    logger.write({
      session_id: 'strip-test',
      tool: 'browser_take_screenshot',
      params: { format: 'jpeg', data: 'base64blobhere...' },
      result: 'ok',
      duration_ms: 300,
    });

    const content = fs.readFileSync(logger.getPath(), 'utf8');
    const entry = JSON.parse(content.trim());
    expect(entry.params.format).toBe('jpeg');
    expect(entry.params).not.toHaveProperty('data');
  });

  it('includes url when provided', () => {
    const logger = new AuditLogger('url-test', tempDir);

    logger.write({
      session_id: 'url-test',
      tool: 'browser_interact',
      params: { action: 'click' },
      result: 'ok',
      url: 'https://example.com/page',
      duration_ms: 50,
    });

    const content = fs.readFileSync(logger.getPath(), 'utf8');
    const entry = JSON.parse(content.trim());
    expect(entry.url).toBe('https://example.com/page');
  });

  it('omits url when not provided', () => {
    const logger = new AuditLogger('no-url-test', tempDir);

    logger.write({
      session_id: 'no-url-test',
      tool: 'browser_snapshot',
      params: {},
      result: 'ok',
      duration_ms: 10,
    });

    const content = fs.readFileSync(logger.getPath(), 'utf8');
    const entry = JSON.parse(content.trim());
    expect(entry.url).toBeUndefined();
  });

  it('includes tip field when provided', () => {
    const logger = new AuditLogger('test', tempDir);
    logger.write({
      session_id: 'test',
      tool: 'browser_evaluate',
      params: { expression: 'document.querySelector("button").click()' },
      result: 'ok',
      duration_ms: 50,
      tip: 'Tip: use browser_interact instead',
    });

    const lines = fs.readFileSync(logger.getPath(), 'utf8').trim().split('\n');
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.tip).toBe('Tip: use browser_interact instead');
  });

  it('omits tip field when null', () => {
    const logger = new AuditLogger('test', tempDir);
    logger.write({
      session_id: 'test',
      tool: 'browser_tabs',
      params: { action: 'list' },
      result: 'ok',
      duration_ms: 10,
    });

    const lines = fs.readFileSync(logger.getPath(), 'utf8').trim().split('\n');
    const entry = JSON.parse(lines[lines.length - 1]);
    expect(entry.tip).toBeUndefined();
  });

  it('includes client field when provided', () => {
    const logger = new AuditLogger('test', tempDir);
    logger.write({
      session_id: 'test',
      tool: 'connect',
      params: { client_id: 'my-session' },
      result: 'ok',
      duration_ms: 500,
      client: { name: 'claude-code', version: '1.0.0' },
    });

    const content = fs.readFileSync(logger.getPath(), 'utf8');
    const entry = JSON.parse(content.trim());
    expect(entry.client).toEqual({ name: 'claude-code', version: '1.0.0' });
  });

  it('includes experiments snapshot when provided', () => {
    const logger = new AuditLogger('test', tempDir);
    logger.write({
      session_id: 'test',
      tool: 'browser_interact',
      params: { action: 'click' },
      result: 'ok',
      duration_ms: 42,
      experiments: { page_diffing: true, smart_waiting: false, mouse_humanization: true, storage_inspection: false },
    });

    const content = fs.readFileSync(logger.getPath(), 'utf8');
    const entry = JSON.parse(content.trim());
    expect(entry.experiments).toEqual({
      page_diffing: true,
      smart_waiting: false,
      mouse_humanization: true,
      storage_inspection: false,
    });
  });

  it('omits client and experiments when not provided', () => {
    const logger = new AuditLogger('test', tempDir);
    logger.write({
      session_id: 'test',
      tool: 'browser_snapshot',
      params: {},
      result: 'ok',
      duration_ms: 10,
    });

    const content = fs.readFileSync(logger.getPath(), 'utf8');
    const entry = JSON.parse(content.trim());
    expect(entry.client).toBeUndefined();
    expect(entry.experiments).toBeUndefined();
  });
});
