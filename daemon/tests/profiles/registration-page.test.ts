import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registrationHtml, registrationScript } from '../../src/profiles/registration-page';

const PAGE_ORIGIN = 'http://127.0.0.1:5555';

/**
 * Execute the page's inline script against a hand-rolled DOM stub.
 *
 * No jsdom / happy-dom: the script's only free identifiers are `window`,
 * `document`, `location`, `setTimeout` and `clearTimeout`. The first three are
 * injected as `new Function` parameters (which shadow the globals); the timer
 * pair resolves to vitest's fake timers on the global object.
 */
function runPage(profile: string) {
  const classes = new Set<string>();
  const listeners: Record<string, Array<(e: any) => void>> = {};
  const posted: Array<{ data: any; targetOrigin: string }> = [];

  const doc = {
    title: '',
    body: {
      classList: {
        add: (c: string) => { classes.add(c); },
        remove: (c: string) => { classes.delete(c); },
      },
    },
  };
  const win: any = {
    addEventListener: (type: string, fn: (e: any) => void) => {
      (listeners[type] ||= []).push(fn);
    },
    postMessage: (data: any, targetOrigin: string) => {
      posted.push({ data, targetOrigin });
    },
  };
  const location = { origin: PAGE_ORIGIN };

  const run = new Function('window', 'document', 'location', registrationScript(profile));
  run(win, doc, location);

  /** Deliver a message event to the page's own listener. */
  const dispatch = (data: any, opts: { source?: any; origin?: string } = {}) => {
    const event = {
      source: 'source' in opts ? opts.source : win,
      origin: opts.origin ?? PAGE_ORIGIN,
      data,
    };
    for (const fn of listeners.message ?? []) fn(event);
  };

  /** Deliver a well-formed ack for this profile. */
  const ack = (opts: { source?: any; origin?: string; profile?: string } = {}) =>
    dispatch(
      {
        __supersurf: true,
        action: 'register-profile-ack',
        profile: 'profile' in opts ? opts.profile : profile,
      },
      opts,
    );

  return { win, doc, classes, posted, dispatch, ack };
}

describe('registrationScript (executed)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('posts register-profile and arms exactly one pending timer', () => {
    const page = runPage('dev');

    expect(page.posted).toHaveLength(1);
    expect(page.posted[0].data).toEqual({
      __supersurf: true,
      action: 'register-profile',
      profile: 'dev',
    });
    expect(vi.getTimerCount()).toBe(1);
  });

  it('does NOT claim readiness before an ack arrives', () => {
    const page = runPage('dev');

    // The original bug: is-ready was added unconditionally after postMessage.
    expect(page.classes.has('is-ready')).toBe(false);
    expect(page.classes.has('is-failed')).toBe(false);
    expect(page.doc.title).toBe('');
  });

  it('goes ready on an ack and cancels the timeout', () => {
    const page = runPage('dev');

    page.ack();

    expect(page.classes.has('is-ready')).toBe(true);
    expect(page.classes.has('is-failed')).toBe(false);
    expect(page.doc.title).toBe('Profile ready — dev');
    // Deleting `clearTimeout(timer)` leaves the timer pending.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stays ready after the 15s mark once acked', () => {
    const page = runPage('dev');
    page.ack();

    vi.advanceTimersByTime(20_000);

    expect(page.classes.has('is-ready')).toBe(true);
    expect(page.classes.has('is-failed')).toBe(false);
    expect(page.doc.title).toBe('Profile ready — dev');
  });

  it('fails after 15s with no ack', () => {
    const page = runPage('dev');

    vi.advanceTimersByTime(14_999);
    expect(page.classes.has('is-failed')).toBe(false);

    vi.advanceTimersByTime(1);
    expect(page.classes.has('is-failed')).toBe(true);
    expect(page.classes.has('is-ready')).toBe(false);
    expect(page.doc.title).toBe('Registration timed out — dev');
  });

  it('lets a late ack clear the failed state', () => {
    const page = runPage('dev');
    vi.advanceTimersByTime(15_000);
    expect(page.classes.has('is-failed')).toBe(true);

    page.ack();

    expect(page.classes.has('is-failed')).toBe(false);
    expect(page.classes.has('is-ready')).toBe(true);
    expect(page.doc.title).toBe('Profile ready — dev');
  });

  it('ignores an ack from a foreign origin', () => {
    const page = runPage('dev');

    page.ack({ origin: 'https://evil.example' });

    expect(page.classes.has('is-ready')).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('ignores an ack from a foreign window', () => {
    const page = runPage('dev');

    page.ack({ source: { notThisWindow: true } });

    expect(page.classes.has('is-ready')).toBe(false);
  });

  it('ignores an ack for a different profile', () => {
    const page = runPage('dev');

    page.ack({ profile: 'other' });

    expect(page.classes.has('is-ready')).toBe(false);
  });

  it('ignores unrelated and malformed messages', () => {
    const page = runPage('dev');

    page.dispatch(null);
    page.dispatch('a string');
    page.dispatch({ __supersurfConsole: { level: 'log', text: 'hi' } });
    page.dispatch({ __supersurf: true, action: 'register-profile', profile: 'dev' });

    expect(page.classes.has('is-ready')).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('survives a profile name with an apostrophe', () => {
    const page = runPage("o'dev");

    expect(page.posted[0].data.profile).toBe("o'dev");
    page.ack();
    expect(page.classes.has('is-ready')).toBe(true);
    expect(page.doc.title).toBe("Profile ready — o'dev");
  });

  it('survives a hostile profile name without breaking the script', () => {
    const page = runPage('</script><script>alert(1)</script>');

    expect(page.posted[0].data.profile).toBe('</script><script>alert(1)</script>');
    page.ack();
    expect(page.classes.has('is-ready')).toBe(true);
  });
});

describe('registrationHtml', () => {
  it('includes the profile name and register-profile postMessage', () => {
    const html = registrationHtml('684f7687');
    expect(html).toContain('684f7687');
    expect(html).toContain("action: 'register-profile'");
    expect(html).toContain("profile: '684f7687'");
  });

  it('embeds the executed script verbatim', () => {
    // Guards the extraction: the tests above are only meaningful if the page
    // actually ships the script they run.
    expect(registrationHtml('dev')).toContain(registrationScript('dev'));
  });

  it('keeps the settled guard inside the timeout callback', () => {
    // Structural, not behavioural: once clearTimeout works the guard is
    // unreachable, so no execution test can distinguish its removal. It is the
    // second line of defence if the timer ever survives cancellation.
    expect(registrationScript('dev')).toMatch(/if \(settled\) return;/);
  });

  it('does not promise auto-close and explains the tab stays open', () => {
    const html = registrationHtml('dev');
    expect(html).not.toMatch(/will close automatically/i);
    expect(html).toMatch(/close this tab|keep this tab|manually/i);
  });

  it('does not claim readiness in the initial title', () => {
    const html = registrationHtml('dev');
    const title = /<title>([^<]*)<\/title>/.exec(html)?.[1];
    expect(title).toBeDefined();
    // The title is painted before any ack, and stays put if JS is disabled.
    expect(title).not.toMatch(/ready|registered|connected|complete/i);
    expect(title).toMatch(/registering/i);
  });

  it('renders a failure section with recovery guidance', () => {
    const html = registrationHtml('dev');
    expect(html).toContain('class="failed"');
    expect(html).toContain('chrome://extensions');
  });

  it('carries the CSS that makes each state visible', () => {
    const html = registrationHtml('dev');
    // Without these rules the class toggles above are inert on screen.
    expect(html).toMatch(/body\.is-failed \.failed \{\s*display: block;\s*\}/);
    expect(html).toMatch(/body\.is-ready \.ready \{\s*display: block;\s*\}/);
    expect(html).toMatch(/body\.is-ready \.failed \{\s*display: none;\s*\}/);
    expect(html).toMatch(/body\.is-failed \.pending \{\s*display: none;\s*\}/);
  });

  it('escapes a hostile profile name in the markup', () => {
    const html = registrationHtml('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('</script>alert');
  });

  it('escapes quotes and backslashes for the inline script literal', () => {
    const html = registrationHtml("o'dev\\x");
    expect(html).toContain("profile: 'o\\'dev\\\\x'");
    expect(html).toContain('o&#39;dev\\x');
  });
});
