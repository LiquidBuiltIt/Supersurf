import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getSessionsDir,
  findUsageLogs,
  buildOutputName,
  runExportProgram,
} from '../src/bin/export';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ss-export-'));
}

describe('getSessionsDir', () => {
  it('resolves under <homedir>/.supersurf/logs/sessions', () => {
    expect(getSessionsDir('/home/x')).toBe('/home/x/.supersurf/logs/sessions');
  });
});

describe('findUsageLogs', () => {
  it('returns only metrics-*.ndjson and audit-*.ndjson, sorted, as absolute paths', () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, 'metrics-b.ndjson'), '{}');
    fs.writeFileSync(path.join(dir, 'audit-a.ndjson'), '{}');
    fs.writeFileSync(path.join(dir, 'server.log'), 'x');
    fs.writeFileSync(path.join(dir, 'metrics-c.txt'), 'x');
    fs.writeFileSync(path.join(dir, 'supersurf-debug-1.log'), 'x');

    const result = findUsageLogs(dir);

    expect(result).toEqual([
      path.join(dir, 'audit-a.ndjson'),
      path.join(dir, 'metrics-b.ndjson'),
    ]);
  });

  it('returns an empty array when the directory does not exist', () => {
    expect(findUsageLogs('/no/such/dir/anywhere')).toEqual([]);
  });
});

describe('buildOutputName', () => {
  it('produces a filesystem-safe timestamped zip name', () => {
    const name = buildOutputName(new Date('2026-07-23T14:05:09.123Z'));
    expect(name).toBe('supersurf-usage-logs-2026-07-23T14-05-09-123Z.zip');
  });
});

describe('runExportProgram', () => {
  it('returns 1 and does not invoke zip when there are no logs', async () => {
    const dir = mkTmp(); // empty
    const zip = vi.fn();
    const stderr = vi.fn();

    const code = await runExportProgram([], { sessionsDir: dir, zip, stderr });

    expect(code).toBe(1);
    expect(zip).not.toHaveBeenCalled();
    expect(stderr.mock.calls.join('')).toContain('No usage-metrics logs');
  });

  it('zips all matching files into cwd and returns 0 on success', async () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, 'metrics-a.ndjson'), '{}');
    fs.writeFileSync(path.join(dir, 'audit-b.ndjson'), '{}');
    const zip = vi.fn();
    const stdout = vi.fn();

    const code = await runExportProgram([], {
      sessionsDir: dir,
      cwd: '/work/here',
      now: new Date('2026-07-23T14:05:09.000Z'),
      zip,
      stdout,
    });

    expect(code).toBe(0);
    expect(zip).toHaveBeenCalledTimes(1);
    const [outPath, files] = zip.mock.calls[0];
    expect(outPath).toBe('/work/here/supersurf-usage-logs-2026-07-23T14-05-09-000Z.zip');
    expect(files).toEqual([
      path.join(dir, 'audit-b.ndjson'),
      path.join(dir, 'metrics-a.ndjson'),
    ]);
    expect(stdout.mock.calls.join('')).toContain('2 usage-log file');
  });

  it('returns 1 with an install hint when the zip binary is missing', async () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, 'metrics-a.ndjson'), '{}');
    const zip = vi.fn(() => {
      const e: any = new Error('spawn zip ENOENT');
      e.code = 'ENOENT';
      throw e;
    });
    const stderr = vi.fn();

    const code = await runExportProgram([], { sessionsDir: dir, zip, stderr });

    expect(code).toBe(1);
    expect(stderr.mock.calls.join('')).toContain("'zip' CLI was not found");
  });
});
