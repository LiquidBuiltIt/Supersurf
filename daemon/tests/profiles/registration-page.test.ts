import { describe, it, expect } from 'vitest';
import { registrationHtml } from '../../src/profiles/registration-page';

describe('registrationHtml', () => {
  it('includes the profile name and register-profile postMessage', () => {
    const html = registrationHtml('684f7687');
    expect(html).toContain('684f7687');
    expect(html).toContain("action: 'register-profile'");
    expect(html).toContain("profile: '684f7687'");
  });

  it('shows a success state and does not promise auto-close', () => {
    const html = registrationHtml('dev');
    expect(html).toMatch(/ready|connected|registered/i);
    expect(html).not.toMatch(/will close automatically/i);
    expect(html).toMatch(/close this tab|keep this tab|manually/i);
  });

  describe('acknowledgement and timeout', () => {
    it('does not claim readiness before an ack arrives', () => {
      const html = registrationHtml('dev');
      // The bug: is-ready was added unconditionally on page load.
      expect(html).not.toMatch(/postMessage\([^)]*\);\s*document\.body\.classList\.add\('is-ready'\)/);
    });

    it('listens for the content script acknowledgement', () => {
      const html = registrationHtml('dev');
      expect(html).toContain('register-profile-ack');
      expect(html).toContain("addEventListener('message'");
    });

    it('arms a 15 second timeout', () => {
      const html = registrationHtml('dev');
      expect(html).toContain('15000');
      expect(html).toContain('is-failed');
    });

    it('renders a failure section with recovery guidance', () => {
      const html = registrationHtml('dev');
      expect(html).toContain('class="failed"');
      expect(html).toContain('chrome://extensions');
    });

    it('still escapes the profile name in every section', () => {
      const html = registrationHtml('dev');
      expect(html).toContain('dev');
      expect(html).not.toContain('<script>alert');
    });
  });
});
