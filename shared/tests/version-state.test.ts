import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { shouldShowUpgradeNotice, checkAndTouchVersionState } from '../version-state/state';

describe('shouldShowUpgradeNotice', () => {
  it('true on a major jump', () => {
    expect(shouldShowUpgradeNotice('1.0.23', '2.0.0')).toBe(true);
  });

  it('false on a same-major minor bump', () => {
    expect(shouldShowUpgradeNotice('2.3.0', '2.4.0')).toBe(false);
  });

  it('false on a same-major patch bump', () => {
    expect(shouldShowUpgradeNotice('2.3.1', '2.3.2')).toBe(false);
  });

  it('false on a downgrade', () => {
    expect(shouldShowUpgradeNotice('3.0.0', '2.9.9')).toBe(false);
  });

  it('false when last version is null', () => {
    expect(shouldShowUpgradeNotice(null, '2.0.0')).toBe(false);
  });

  it('false when last version is garbage', () => {
    expect(shouldShowUpgradeNotice('not-a-version', '2.0.0')).toBe(false);
  });

  it('false when current version is garbage', () => {
    expect(shouldShowUpgradeNotice('1.0.0', 'not-a-version')).toBe(false);
  });

  it('false on identical versions', () => {
    expect(shouldShowUpgradeNotice('2.0.0', '2.0.0')).toBe(false);
  });
});

describe('checkAndTouchVersionState', () => {
  let tmpDir: string;
  let statePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'version-state-'));
    statePath = path.join(tmpDir, 'version-state.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('first run: no file present records state without notifying', () => {
    const result = checkAndTouchVersionState('3.3.0', statePath);
    expect(result.shouldNotify).toBe(false);
    expect(fs.existsSync(statePath)).toBe(true);

    const written = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(written.last_version).toBe('3.3.0');
    expect(typeof written.last_used_at).toBe('string');
    expect(new Date(written.last_used_at).toString()).not.toBe('Invalid Date');
  });

  it('round-trips: a recorded major jump is detected on next check, then updated', () => {
    checkAndTouchVersionState('1.0.23', statePath);

    const upgraded = checkAndTouchVersionState('2.0.0', statePath);
    expect(upgraded.shouldNotify).toBe(true);

    const written = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(written.last_version).toBe('2.0.0');

    // Same major again — no repeat notice.
    const again = checkAndTouchVersionState('2.0.1', statePath);
    expect(again.shouldNotify).toBe(false);
  });

  it('does not notify on a same-major minor/patch jump', () => {
    checkAndTouchVersionState('2.3.0', statePath);
    const result = checkAndTouchVersionState('2.4.5', statePath);
    expect(result.shouldNotify).toBe(false);
  });

  it('does not notify on a downgrade', () => {
    checkAndTouchVersionState('3.0.0', statePath);
    const result = checkAndTouchVersionState('2.9.0', statePath);
    expect(result.shouldNotify).toBe(false);
  });

  it('treats a malformed state file as first-run — no throw, no notice', () => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, '{ not valid json', 'utf-8');

    const result = checkAndTouchVersionState('2.0.0', statePath);
    expect(result.shouldNotify).toBe(false);

    const written = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(written.last_version).toBe('2.0.0');
  });

  it('never throws even when the directory cannot be created (best-effort write)', () => {
    // Point at a path whose parent is a file, not a directory — mkdirSync fails.
    const blockerFile = path.join(tmpDir, 'blocker');
    fs.writeFileSync(blockerFile, 'x');
    const badPath = path.join(blockerFile, 'sub', 'version-state.json');

    expect(() => checkAndTouchVersionState('2.0.0', badPath)).not.toThrow();
  });
});
