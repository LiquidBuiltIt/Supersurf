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

  describe('agents.relay is left out', () => {
    const base = { daemon: { port: 5555 }, agents: { multi_agent: false } };

    it('ignores relay true and false', () => {
      write({ ...base, agents: { ...base.agents, relay: false } });
      const a = hash();
      write({ ...base, agents: { ...base.agents, relay: true } });
      expect(hash()).toBe(a);
    });

    it('ignores relay added and removed', () => {
      write(base);
      const a = hash();
      write({ ...base, agents: { ...base.agents, relay: true } });
      expect(hash()).toBe(a);
    });

    it('ignores adding an agents object that holds only relay', () => {
      write({ daemon: { port: 5555 } });
      const a = hash();
      write({ daemon: { port: 5555 }, agents: { relay: true } });
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
      write({ agents: { multi_agent: false, relay: true } });
      const a = hash();
      write({ agents: { multi_agent: true, relay: true } });
      expect(hash()).not.toBe(a);
    });

    it('changes on a leaf outside agents', () => {
      write({ daemon: { port: 5555 }, agents: { relay: true } });
      const a = hash();
      write({ daemon: { port: 5556 }, agents: { relay: true } });
      expect(hash()).not.toBe(a);
    });

    it('changes when a non-relay agents leaf appears next to relay', () => {
      write({ agents: { relay: true } });
      const a = hash();
      write({ agents: { relay: true, multi_agent: true } });
      expect(hash()).not.toBe(a);
    });
  });
});
