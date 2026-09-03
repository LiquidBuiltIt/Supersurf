import { describe, it, expect, vi } from 'vitest';
import { compareExtensionVersion, applyHandshakeVersion } from '../../src/profiles/extension-version';
import type { PooledConnection } from '../../src/profiles/types';

describe('compareExtensionVersion', () => {
  describe('accepts', () => {
    it('returns ok for an exact match', () => {
      const v = compareExtensionVersion('3.4.0', '3.4.0');
      expect(v.status).toBe('ok');
      expect(v.message).toBeNull();
    });

    it('returns warn for a patch-only difference (extension ahead)', () => {
      const v = compareExtensionVersion('3.4.0', '3.4.7');
      expect(v.status).toBe('warn');
      expect(v.message).toContain('3.4.7');
      expect(v.message).toContain('3.4.0');
    });

    it('returns warn for a patch-only difference (extension behind)', () => {
      expect(compareExtensionVersion('3.4.7', '3.4.0').status).toBe('warn');
    });

    it('ignores a prerelease/build suffix when the core triple matches', () => {
      expect(compareExtensionVersion('3.4.0', '3.4.0-beta.1').status).toBe('ok');
    });
  });

  describe('rejects', () => {
    it('rejects a minor mismatch — the 2.1.0 capabilities.profiles case', () => {
      const v = compareExtensionVersion('2.0.0', '2.1.0');
      expect(v.status).toBe('rejected');
      expect(v.message).toContain('2.1.0');
      expect(v.message).toContain('2.0.0');
    });

    it('rejects a major mismatch', () => {
      expect(compareExtensionVersion('3.4.0', '2.4.0').status).toBe('rejected');
    });

    it('rejects when the extension is a major ahead', () => {
      expect(compareExtensionVersion('3.4.0', '4.0.0').status).toBe('rejected');
    });

    it('names both versions and tells the user how to recover', () => {
      const v = compareExtensionVersion('3.4.0', '2.9.0');
      expect(v.message).toMatch(/chrome:\/\/extensions/);
    });

    it('marks the guard active when both versions parsed', () => {
      expect(compareExtensionVersion('3.4.0', '3.4.0').guardActive).toBe(true);
      expect(compareExtensionVersion('3.4.0', '3.4.7').guardActive).toBe(true);
      expect(compareExtensionVersion('3.4.0', '2.9.0').guardActive).toBe(true);
    });
  });

  describe('fails open on unparsable input', () => {
    it('warns when the daemon version is the literal "unknown"', () => {
      // getVersion() in daemon/src/main.ts returns 'unknown' when it cannot
      // locate its own package.json. Rejecting there would brick that install.
      expect(compareExtensionVersion('unknown', '3.4.0').status).toBe('warn');
    });

    it('warns when the extension omits version entirely', () => {
      const v = compareExtensionVersion('3.4.0', undefined);
      expect(v.status).toBe('warn');
      expect(v.message).toContain('did not report');
    });

    it('warns on a non-string extension version', () => {
      expect(compareExtensionVersion('3.4.0', 42).status).toBe('warn');
    });

    it('warns on a malformed extension version', () => {
      expect(compareExtensionVersion('3.4.0', 'v3').status).toBe('warn');
    });

    it('marks the guard inactive when the extension version is unparsable', () => {
      expect(compareExtensionVersion('3.4.0', 'v3').guardActive).toBe(false);
      expect(compareExtensionVersion('3.4.0', undefined).guardActive).toBe(false);
    });

    it('marks the guard inactive when the daemon version is unparsable', () => {
      expect(compareExtensionVersion('unknown', '3.4.0').guardActive).toBe(false);
    });
  });
});

function stubConn(profile: string | null = null): PooledConnection {
  return {
    ws: { readyState: 1, close: vi.fn(), send: vi.fn() } as any,
    profile,
    browser: 'chrome',
    buildTimestamp: null,
    pingInterval: null,
    inflight: new Map(),
    keepBrowserOnSessionEnd: false,
    version: null,
    versionStatus: 'pending',
    versionError: null,
  };
}

function stubMatchmaker() {
  return {
    failPendingMatches: vi.fn().mockReturnValue(0),
    recordVersionRejection: vi.fn(),
    clearVersionRejection: vi.fn(),
  };
}

describe('applyHandshakeVersion', () => {
  it('promotes a matching connection to ok', () => {
    const conn = stubConn('dev');
    const mm = stubMatchmaker();

    const verdict = applyHandshakeVersion(conn, { version: '3.4.0' }, '3.4.0', mm as any);

    expect(verdict.status).toBe('ok');
    expect(conn.versionStatus).toBe('ok');
    expect(conn.version).toBe('3.4.0');
    expect(conn.versionError).toBeNull();
    expect(mm.clearVersionRejection).toHaveBeenCalledWith('dev');
    expect(mm.failPendingMatches).not.toHaveBeenCalled();
  });

  it('promotes a patch-skewed connection to warn and still clears the rejection', () => {
    const conn = stubConn('dev');
    const mm = stubMatchmaker();

    const verdict = applyHandshakeVersion(conn, { version: '3.4.9' }, '3.4.0', mm as any);

    expect(verdict.status).toBe('warn');
    expect(conn.versionStatus).toBe('warn');
    expect(conn.versionError).toContain('patch level');
    expect(mm.clearVersionRejection).toHaveBeenCalledWith('dev');
  });

  it('marks a minor mismatch rejected, records it, and fails pending matches', () => {
    const conn = stubConn('dev');
    const mm = stubMatchmaker();

    const verdict = applyHandshakeVersion(conn, { version: '3.5.0' }, '3.4.0', mm as any);

    expect(verdict.status).toBe('rejected');
    expect(conn.versionStatus).toBe('rejected');
    expect(conn.versionError).toContain('not compatible');
    expect(mm.recordVersionRejection).toHaveBeenCalledWith({
      profile: 'dev',
      version: '3.5.0',
      message: conn.versionError,
    });
    expect(mm.failPendingMatches).toHaveBeenCalledTimes(1);
    expect(mm.failPendingMatches.mock.calls[0][0]).toBe('dev');
    expect(mm.failPendingMatches.mock.calls[0][1].message).toBe(conn.versionError);
  });

  it('prefers the handshake profile over the cookie profile when failing matches', () => {
    const conn = stubConn(null);
    const mm = stubMatchmaker();

    applyHandshakeVersion(conn, { version: '1.0.0', profile: 'dev' }, '3.4.0', mm as any);

    expect(mm.failPendingMatches.mock.calls[0][0]).toBe('dev');
    expect(mm.recordVersionRejection.mock.calls[0][0].profile).toBe('dev');
  });

  it('closes the offending socket with a 4001 code', () => {
    const conn = stubConn('dev');
    const mm = stubMatchmaker();

    applyHandshakeVersion(conn, { version: '1.0.0' }, '3.4.0', mm as any);

    expect(conn.ws.close).toHaveBeenCalledWith(4001, 'extension version mismatch');
  });

  it('does not close the socket on warn', () => {
    const conn = stubConn('dev');
    const mm = stubMatchmaker();

    applyHandshakeVersion(conn, { version: '3.4.9' }, '3.4.0', mm as any);

    expect(conn.ws.close).not.toHaveBeenCalled();
  });

  it('leaves a connection usable when the handshake omits version', () => {
    const conn = stubConn('dev');
    const mm = stubMatchmaker();

    const verdict = applyHandshakeVersion(conn, {}, '3.4.0', mm as any);

    expect(verdict.status).toBe('warn');
    expect(conn.versionStatus).toBe('warn');
    expect(conn.ws.close).not.toHaveBeenCalled();
  });

  it('reports the guard as inactive when the handshake omits version', () => {
    const conn = stubConn('dev');
    const verdict = applyHandshakeVersion(conn, {}, '3.4.0', stubMatchmaker() as any);
    expect(verdict.guardActive).toBe(false);
  });

  it('reports the guard as active on a patch-level warning', () => {
    const conn = stubConn('dev');
    const verdict = applyHandshakeVersion(conn, { version: '3.4.9' }, '3.4.0', stubMatchmaker() as any);
    expect(verdict.guardActive).toBe(true);
  });
});
