import { describe, it, expect } from 'vitest';
import { compareExtensionVersion } from '../../src/profiles/extension-version';

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
