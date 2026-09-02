import { describe, it, expect, vi } from 'vitest';
import {
  handleProfileRegisterRelay,
  RELAY_MAX_ATTEMPTS,
  RELAY_RETRY_MS,
} from '../../src/handlers/profile-register-relay';

const PAGE_ORIGIN = 'http://127.0.0.1:5555';

/** The registration page's own timeout. The relay must give up before this. */
const PAGE_TIMEOUT_MS = 15_000;

type Reply = { ok?: boolean } | { lastError: string } | { throw: true };

/**
 * Drive the relay with a scripted sequence of service-worker replies.
 *
 * No browser and no timers: `setTimeout` is captured into a queue that the test
 * drains by hand, so the retry budget is countable rather than wall-clock bound.
 */
function runRelay(replies: Reply[], opts: { origin?: string; data?: any } = {}) {
  const posted: Array<{ data: any; targetOrigin: string }> = [];
  const sent: unknown[] = [];
  const scheduled: Array<{ fn: () => void; ms: number }> = [];
  let lastError: { message?: string } | undefined;
  let call = 0;

  const runtime = {
    sendMessage: vi.fn((message: unknown, callback?: (response: any) => void) => {
      sent.push(message);
      const reply = replies[Math.min(call, replies.length - 1)];
      call++;
      if (reply && 'throw' in reply) throw new Error('extension context invalidated');
      if (reply && 'lastError' in reply) {
        lastError = { message: reply.lastError };
        callback?.(undefined);
        lastError = undefined;
        return;
      }
      lastError = undefined;
      callback?.(reply);
    }),
    get lastError() {
      return lastError;
    },
  };

  const handled = handleProfileRegisterRelay(
    {
      data: 'data' in opts
        ? opts.data
        : { __supersurf: true, action: 'register-profile', profile: 'dev' },
      origin: 'origin' in opts ? opts.origin : PAGE_ORIGIN,
    },
    {
      runtime,
      postMessage: (data, targetOrigin) => { posted.push({ data, targetOrigin }); },
      setTimeout: (fn, ms) => { scheduled.push({ fn, ms }); },
    },
  );

  /** Run every currently-pending retry, repeatedly, until the relay stops. */
  const drain = () => {
    let guard = 0;
    while (scheduled.length && guard++ < RELAY_MAX_ATTEMPTS * 4) {
      const next = scheduled.shift()!;
      next.fn();
    }
  };

  return { handled, posted, sent, scheduled, runtime, drain };
}

describe('handleProfileRegisterRelay', () => {
  it('acks the page when the worker reports { ok: true }', () => {
    const relay = runRelay([{ ok: true }]);

    expect(relay.handled).toBe(true);
    expect(relay.sent).toEqual([{ type: 'profileRegister', profile: 'dev' }]);
    expect(relay.posted).toHaveLength(1);
    expect(relay.posted[0].data).toEqual({
      __supersurf: true,
      action: 'register-profile-ack',
      profile: 'dev',
    });
  });

  it('does NOT ack when the worker reports { ok: false }', () => {
    const relay = runRelay([{ ok: false }]);

    // The write failed. Acking here would paint "Profile ready" over a profile
    // that was never bound.
    expect(relay.posted).toEqual([]);
    expect(relay.scheduled).toEqual([]);
  });

  it('does NOT ack on an empty or shapeless reply', () => {
    expect(runRelay([undefined as any]).posted).toEqual([]);
    expect(runRelay([{} as any]).posted).toEqual([]);
  });

  it('posts the ack to the page origin, never to *', () => {
    const relay = runRelay([{ ok: true }]);

    expect(relay.posted[0].targetOrigin).toBe(PAGE_ORIGIN);
    expect(relay.posted[0].targetOrigin).not.toBe('*');
  });

  it('retries on chrome.runtime.lastError and acks once an attempt succeeds', () => {
    const relay = runRelay([
      { lastError: 'Could not establish connection.' },
      { lastError: 'Could not establish connection.' },
      { ok: true },
    ]);

    // First attempt failed, so an ack must not have been sent yet.
    expect(relay.posted).toEqual([]);
    expect(relay.scheduled).toHaveLength(1);

    relay.drain();

    expect(relay.sent).toHaveLength(3);
    expect(relay.posted).toHaveLength(1);
    expect(relay.posted[0].data.action).toBe('register-profile-ack');
  });

  it('retries when sendMessage throws outright', () => {
    const relay = runRelay([{ throw: true }, { ok: true }]);

    expect(relay.posted).toEqual([]);
    relay.drain();

    expect(relay.sent).toHaveLength(2);
    expect(relay.posted).toHaveLength(1);
  });

  it('gives up after the attempt budget and never acks', () => {
    const relay = runRelay([{ lastError: 'Could not establish connection.' }]);

    relay.drain();

    expect(relay.sent).toHaveLength(RELAY_MAX_ATTEMPTS);
    expect(relay.scheduled).toEqual([]);
    expect(relay.posted).toEqual([]);
  });

  it('spreads the budget close to, but under, the page 15s timeout', () => {
    const relay = runRelay([{ lastError: 'Could not establish connection.' }]);
    const delays: number[] = [];
    // Re-drain by hand so every scheduled delay is observable.
    let pending = relay.scheduled.splice(0);
    while (pending.length) {
      for (const t of pending) delays.push(t.ms);
      for (const t of pending) t.fn();
      pending = relay.scheduled.splice(0);
    }

    const lastAttemptAt = delays.reduce((a, b) => a + b, 0);
    // At 10 attempts x 500ms the relay quit at 4.5s and the page then stalled a
    // further 10s before blaming the extension.
    expect(lastAttemptAt).toBeGreaterThan(PAGE_TIMEOUT_MS * 0.7);
    expect(lastAttemptAt).toBeLessThan(PAGE_TIMEOUT_MS);
    expect(delays.every((d) => d === RELAY_RETRY_MS)).toBe(true);
  });

  it('swallows a postMessage rejection from an opaque origin', () => {
    const scheduled: Array<() => void> = [];
    expect(() =>
      handleProfileRegisterRelay(
        { data: { __supersurf: true, action: 'register-profile', profile: 'dev' }, origin: 'null' },
        {
          runtime: {
            sendMessage: (_m, cb) => cb?.({ ok: true }),
            lastError: undefined,
          },
          postMessage: () => { throw new Error('invalid target origin'); },
          setTimeout: (fn) => { scheduled.push(fn); },
        },
      ),
    ).not.toThrow();
  });

  it('ignores unrelated, malformed and profile-less page messages', () => {
    for (const data of [
      null,
      undefined,
      'a string',
      { __supersurfConsole: { level: 'log', text: 'hi' } },
      { __supersurf: true, action: 'register-profile-ack', profile: 'dev' },
      { __supersurf: true, action: 'register-profile' },
      { __supersurf: 'yes', action: 'register-profile', profile: 'dev' },
    ]) {
      const relay = runRelay([{ ok: true }], { data });
      expect(relay.handled).toBe(false);
      expect(relay.sent).toEqual([]);
      expect(relay.posted).toEqual([]);
    }
  });
});
