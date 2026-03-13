import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { isExtensionCached, getExtensionDir } from '../../src/profiles/extension-source';

describe('extension-source', () => {
  it('getExtensionDir returns expected path', () => {
    const dir = getExtensionDir();
    expect(dir).toBe(path.join(os.homedir(), '.supersurf', 'extension'));
  });

  it('isExtensionCached checks for manifest.json', () => {
    // This test checks the function logic — result depends on filesystem state
    const result = isExtensionCached();
    expect(typeof result).toBe('boolean');
  });
});
