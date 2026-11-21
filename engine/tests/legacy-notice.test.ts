import { describe, it, expect, afterEach } from 'vitest';
import { AgentSession } from '../src/backend';
import type { BackendConfig } from '../src/backend/types';
import { defaultBackend } from '../src/playbooks/runner';
import {
  LEGACY_NOTICE_ENABLED,
  LEGACY_NOTICE_TEXT,
  setLegacyNoticeForTests,
} from '../src/backend/status';
import { createFakeHost } from './helpers/fake-host';

const config = { debug: false, port: 5555, server: { name: 'supersurf', version: '9.9.9' } } as BackendConfig;
const DRIFT = 'config.json changed since daemon start';
const drifted = () => ({ isConfigDrifted: () => true });

afterEach(() => setLegacyNoticeForTests(undefined));

describe('legacy deprecation notice', () => {
  it('ships off', () => {
    expect(LEGACY_NOTICE_ENABLED).toBe(false);
  });

  it('text names agents.relay', () => {
    expect(LEGACY_NOTICE_TEXT).toContain('agents.relay');
  });

  it('text is the settled wording', () => {
    expect(LEGACY_NOTICE_TEXT).toBe(
      'SuperSurf legacy mode is removed in 5.0.0. To switch now, set `agents.relay` to `true` in `~/.supersurf/config.json`, then restart your MCP client.',
    );
  });

  it('gate off: no line on any call', () => {
    const s = new AgentSession(config, createFakeHost());
    for (let i = 0; i < 3; i++) expect(s.statusHeader()).not.toContain(LEGACY_NOTICE_TEXT);
  });

  it('gate on: exactly once per legacy session', () => {
    setLegacyNoticeForTests(true);
    const s = new AgentSession(config, createFakeHost());
    const first = s.statusHeader();
    expect(first).toContain(LEGACY_NOTICE_TEXT);
    expect(first.startsWith(`${LEGACY_NOTICE_TEXT}\n\n`)).toBe(true);
    expect(s.statusHeader()).not.toContain(LEGACY_NOTICE_TEXT);
    expect(s.statusHeader()).not.toContain(LEGACY_NOTICE_TEXT);
  });

  it('gate on: two sessions each get it once', () => {
    setLegacyNoticeForTests(true);
    const a = new AgentSession(config, createFakeHost());
    const b = new AgentSession(config, createFakeHost());
    expect(a.statusHeader()).toContain(LEGACY_NOTICE_TEXT);
    expect(b.statusHeader()).toContain(LEGACY_NOTICE_TEXT);
    expect(a.statusHeader()).not.toContain(LEGACY_NOTICE_TEXT);
    expect(b.statusHeader()).not.toContain(LEGACY_NOTICE_TEXT);
  });

  it('gate on + worker-hosted (shim) session: never', () => {
    setLegacyNoticeForTests(true);
    const s = new AgentSession(config, createFakeHost({ workerHosted: true }));
    for (let i = 0; i < 3; i++) expect(s.statusHeader()).not.toContain(LEGACY_NOTICE_TEXT);
  });

  it('gate on + playbook-run session (runner default backend): never', () => {
    setLegacyNoticeForTests(true);
    const host = createFakeHost({ runConfig: () => config });
    const s = defaultBackend(host) as unknown as AgentSession;
    for (let i = 0; i < 3; i++) expect(s.statusHeader()).not.toContain(LEGACY_NOTICE_TEXT);
  });

  it('drift and notice together: drift first, notice second, each once', () => {
    setLegacyNoticeForTests(true);
    const s = new AgentSession(config, createFakeHost());
    s.extensionServer = drifted() as any;
    const first = s.statusHeader();
    expect(first.indexOf(DRIFT)).toBeGreaterThanOrEqual(0);
    expect(first.indexOf(LEGACY_NOTICE_TEXT)).toBeGreaterThan(first.indexOf(DRIFT));
    const second = s.statusHeader();
    expect(second).not.toContain(DRIFT);
    expect(second).not.toContain(LEGACY_NOTICE_TEXT);
  });

  it('active-branch header puts the notice after drift and before the version part', () => {
    setLegacyNoticeForTests(true);
    const s = new AgentSession(config, createFakeHost());
    s.state = 'connected';
    s.extensionServer = drifted() as any;
    const h = s.statusHeader();
    expect(h.indexOf(DRIFT)).toBeLessThan(h.indexOf(LEGACY_NOTICE_TEXT));
    expect(h.indexOf(LEGACY_NOTICE_TEXT)).toBeLessThan(h.indexOf('v9.9.9'));
  });
});
