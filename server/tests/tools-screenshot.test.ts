import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import { ConfigService } from 'shared';
import { onScreenshot } from '../src/tools/screenshot';
import type { ToolContext } from '../src/tools/lib/types';

function createMockCtx(omitPath: 'inline' | 'path' | 'both' = 'inline'): ToolContext {
  const config = new ConfigService({
    cli: {},
    env: {},
    file: { screenshot: { omit_path: omitPath } },
  });
  return {
    tabId: 1,
    ext: { sendCmd: vi.fn() } as any,
    connectionManager: null,
    config,
    cdp: vi.fn().mockResolvedValue({}),
    eval: vi.fn().mockResolvedValue(undefined),
    sleep: vi.fn().mockResolvedValue(undefined),
    getElementCenter: vi.fn(),
    getSelectorExpression: vi.fn(),
    findAlternativeSelectors: vi.fn(),
    formatResult: vi.fn((_n, r) => ({ content: [{ type: 'text', text: JSON.stringify(r) }] })),
    error: vi.fn((msg) => ({ content: [{ type: 'text', text: msg }], isError: true })),
  };
}

async function tinyJpegBase64(): Promise<string> {
  const buf = await sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
  return buf.toString('base64');
}

describe('onScreenshot()', () => {
  let jpegB64: string;
  const written: string[] = [];

  beforeEach(async () => {
    jpegB64 = await tinyJpegBase64();
    written.length = 0;
  });

  afterEach(() => {
    for (const p of written) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  });

  it('defaults to inline image when path is omitted (omit_path=inline)', async () => {
    const ctx = createMockCtx('inline');
    (ctx.ext.sendCmd as any).mockResolvedValue({ data: jpegB64, mimeType: 'image/jpeg' });

    const result = await onScreenshot(ctx, {}, {});

    expect(result.content.some((c: any) => c.type === 'image')).toBe(true);
    expect(result.content.find((c: any) => c.type === 'text')?.text).toMatch(/Screenshot captured/);
  });

  it('saves to temp dir when omit_path=path and path is omitted', async () => {
    const ctx = createMockCtx('path');
    (ctx.ext.sendCmd as any).mockResolvedValue({ data: jpegB64, mimeType: 'image/jpeg' });

    const result = await onScreenshot(ctx, {}, {});

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content.some((c: any) => c.type === 'image')).toBe(false);

    const match = result.content[0].text.match(/Screenshot saved to (.+?) \(/);
    expect(match).toBeTruthy();
    const savedPath = match![1];
    written.push(savedPath);

    expect(savedPath.startsWith(path.join(os.tmpdir(), 'supersurf-screenshots'))).toBe(true);
    expect(fs.existsSync(savedPath)).toBe(true);
  });

  it('returns both path text and inline image when omit_path=both', async () => {
    const ctx = createMockCtx('both');
    (ctx.ext.sendCmd as any).mockResolvedValue({ data: jpegB64, mimeType: 'image/jpeg' });

    const result = await onScreenshot(ctx, {}, {});

    expect(result.content.some((c: any) => c.type === 'image')).toBe(true);
    const text = result.content.find((c: any) => c.type === 'text')?.text ?? '';
    expect(text).toMatch(/Screenshot saved to /);
    const match = text.match(/Screenshot saved to (.+?)(?:\n|$)/);
    expect(match).toBeTruthy();
    written.push(match![1].trim());
    expect(fs.existsSync(match![1].trim())).toBe(true);
  });

  it('uses the explicit path when provided (ignores omit_path)', async () => {
    const ctx = createMockCtx('inline');
    (ctx.ext.sendCmd as any).mockResolvedValue({ data: jpegB64, mimeType: 'image/jpeg' });

    const home = os.homedir();
    const rel = path.join('.supersurf-test-screenshots', `explicit-${Date.now()}.jpg`);
    const expected = path.join(home, rel);
    fs.mkdirSync(path.dirname(expected), { recursive: true });
    written.push(expected);

    const result = await onScreenshot(ctx, { path: rel }, {});

    expect(result.content[0].text).toContain(`Screenshot saved to ${expected}`);
    expect(result.content.some((c: any) => c.type === 'image')).toBe(false);
    expect(fs.existsSync(expected)).toBe(true);
  });

  it('rawResult without path still returns inline base64 (internal capture)', async () => {
    const ctx = createMockCtx('path');
    (ctx.ext.sendCmd as any).mockResolvedValue({ data: jpegB64, mimeType: 'image/jpeg' });

    const result = await onScreenshot(ctx, {}, { rawResult: true });

    expect(result.data).toBeTruthy();
    expect(typeof result.data).toBe('string');
    expect(result.mimeType).toMatch(/image\//);
    expect(result.path).toBeUndefined();
  });

  it('treats missing config as inline (legacy callers)', async () => {
    const ctx = createMockCtx('inline');
    delete (ctx as any).config;
    (ctx.ext.sendCmd as any).mockResolvedValue({ data: jpegB64, mimeType: 'image/jpeg' });

    const result = await onScreenshot(ctx, {}, {});
    expect(result.content.some((c: any) => c.type === 'image')).toBe(true);
  });
});
