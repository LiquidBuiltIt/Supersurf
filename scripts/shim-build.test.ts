import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, statSync, chmodSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SHIM_TARGETS, MAX_SHIM_BYTES, buildShimAll, checkShimBinaries, type GoRun } from './shim-build';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'shimbuild-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const bin = (dir: string, t: string, bytes: number, mode = 0o755) => {
  mkdirSync(join(dir, 'bin', t), { recursive: true });
  const f = join(dir, 'bin', t, 'supersurf-shim');
  writeFileSync(f, Buffer.alloc(bytes, 1));
  chmodSync(f, mode);
};

describe('buildShimAll', () => {
  // A fake `go build` that only writes the -o file, so the test never needs a toolchain.
  const calls: { go: string; args: string[]; env: Record<string, string | undefined>; cwd: string }[] = [];
  const fakeGo: GoRun = (go, args, opts) => {
    calls.push({ go, args, env: opts.env, cwd: opts.cwd });
    const out = args[args.indexOf('-o') + 1];
    mkdirSync(join(out, '..'), { recursive: true });
    writeFileSync(out, Buffer.alloc(2048, 1));
    return 0;
  };

  it('builds linux and darwin on amd64 and arm64 with a static, stripped, versioned binary', () => {
    calls.length = 0;
    const dir = tmp();
    const outs = buildShimAll({ go: '/x/go', version: '9.9.9', shimDir: dir, run: fakeGo });
    expect(SHIM_TARGETS.map((t) => `${t.goos}-${t.goarch}`)).toEqual(['linux-amd64', 'linux-arm64', 'darwin-amd64', 'darwin-arm64']);
    expect(outs).toEqual(SHIM_TARGETS.map((t) => join(dir, 'bin', `${t.goos}-${t.goarch}`, 'supersurf-shim')));
    expect(calls).toHaveLength(4);
    calls.forEach((c, i) => {
      expect(c.go).toBe('/x/go');
      expect(c.cwd).toBe(dir);
      expect(c.args).toEqual(['build', '-trimpath', '-ldflags', '-s -w -X main.version=9.9.9', '-o', outs[i], '.']);
      expect(c.env).toMatchObject({ CGO_ENABLED: '0', GOOS: SHIM_TARGETS[i].goos, GOARCH: SHIM_TARGETS[i].goarch, GOTOOLCHAIN: 'local' });
    });
    for (const o of outs) expect(statSync(o).mode & 0o777).toBe(0o755);
  });

  it('throws naming the target when go build fails, and stops', () => {
    const dir = tmp();
    let n = 0;
    const run: GoRun = (go, args, opts) => (++n === 2 ? 1 : fakeGo(go, args, opts));
    expect(() => buildShimAll({ go: 'go', version: '1.0.0', shimDir: dir, run })).toThrow(/linux-arm64/);
    expect(n).toBe(2);
  });

  it('removes stale binaries first, so a target that is no longer built cannot ship', () => {
    const dir = tmp();
    bin(dir, 'freebsd-amd64', 2048);
    buildShimAll({ go: 'go', version: '1.0.0', shimDir: dir, run: fakeGo });
    expect(existsSync(join(dir, 'bin', 'freebsd-amd64'))).toBe(false);
  });
});

describe('checkShimBinaries', () => {
  const full = () => {
    const d = tmp();
    for (const t of SHIM_TARGETS) bin(d, `${t.goos}-${t.goarch}`, 4096);
    return d;
  };

  it('passes when all four binaries are executable and sized sanely', () => {
    expect(() => checkShimBinaries(full())).not.toThrow();
  });

  it('names every missing target', () => {
    const d = full();
    rmSync(join(d, 'bin', 'darwin-arm64'), { recursive: true });
    rmSync(join(d, 'bin', 'linux-arm64'), { recursive: true });
    expect(() => checkShimBinaries(d)).toThrow(/darwin-arm64[\s\S]*linux-arm64|linux-arm64[\s\S]*darwin-arm64/);
  });

  it('rejects an empty binary', () => {
    const d = full();
    bin(d, 'linux-amd64', 0);
    expect(() => checkShimBinaries(d)).toThrow(/linux-amd64.*(empty|small)/);
  });

  it('rejects a binary over the size cap', () => {
    const d = full();
    bin(d, 'darwin-amd64', MAX_SHIM_BYTES + 1);
    expect(() => checkShimBinaries(d)).toThrow(/darwin-amd64.*large/);
  });

  it('rejects a binary that is not mode 0755', () => {
    const d = full();
    bin(d, 'linux-amd64', 4096, 0o644);
    expect(() => checkShimBinaries(d)).toThrow(/linux-amd64.*0755/);
  });
});
