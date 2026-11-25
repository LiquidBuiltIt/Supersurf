import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { configHash } from '../src/config-drift';

let dir: string;
let file: string;
const write = (v: unknown) => fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const hash = () => configHash(file);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-drift-'));
  file = path.join(dir, 'config.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('configHash', () => {
  it('returns an empty string for a missing file', () => {
    expect(hash()).toBe('');
  });

  it('hashes unparsable bytes as the raw bytes', () => {
    const raw = '{ not json';
    write(raw);
    expect(hash()).toBe(crypto.createHash('sha256').update(raw).digest('hex'));
  });

  describe('server.legacy is left out', () => {
    const base = { daemon: { port: 5555 }, agents: { multi_agent: false } };

    it('ignores legacy true and false', () => {
      write({ ...base, server: { legacy: true } });
      const a = hash();
      write({ ...base, server: { legacy: false } });
      expect(hash()).toBe(a);
    });

    it('ignores legacy added and removed', () => {
      write(base);
      const a = hash();
      write({ ...base, server: { legacy: false } });
      expect(hash()).toBe(a);
    });

    it('ignores adding a server object that holds only legacy', () => {
      write({ daemon: { port: 5555 } });
      const a = hash();
      write({ daemon: { port: 5555 }, server: { legacy: false } });
      expect(hash()).toBe(a);
    });

    it('ignores whitespace-only edits of a parsable file', () => {
      write(base);
      const a = hash();
      write(JSON.stringify(base));
      expect(hash()).toBe(a);
    });
  });

  describe('every other leaf still counts', () => {
    it('changes on another agents leaf', () => {
      write({ agents: { multi_agent: false }, server: { legacy: false } });
      const a = hash();
      write({ agents: { multi_agent: true }, server: { legacy: false } });
      expect(hash()).not.toBe(a);
    });

    it('changes on a leaf outside agents', () => {
      write({ daemon: { port: 5555 }, server: { legacy: false } });
      const a = hash();
      write({ daemon: { port: 5556 }, server: { legacy: false } });
      expect(hash()).not.toBe(a);
    });

    it('changes when another leaf appears next to server.legacy', () => {
      write({ server: { legacy: false } });
      const a = hash();
      write({ server: { legacy: false }, agents: { multi_agent: true } });
      expect(hash()).not.toBe(a);
    });

    it('changes on a sibling leaf inside server', () => {
      write({ server: { legacy: false, other: 1 } });
      const a = hash();
      write({ server: { legacy: false, other: 2 } });
      expect(hash()).not.toBe(a);
    });
  });
});

describe('main.ts drift wiring', () => {
  it('uses configHash for the startup hash and the watch hash, and hashes the file nowhere else', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.ts'), 'utf8');
    expect(src).toMatch(/const initialHash = configHash\(configPath\)/);
    expect(src).toMatch(/const current = configHash\(configPath\)/);
    expect(src).not.toMatch(/createHash\(/);
  });
});
