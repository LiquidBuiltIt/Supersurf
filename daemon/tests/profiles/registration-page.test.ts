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
});
