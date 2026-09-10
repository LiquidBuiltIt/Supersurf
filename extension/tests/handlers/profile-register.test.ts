import { describe, it, expect, vi } from 'vitest';
import {
  applyProfileRegister,
  handleProfileRegisterMessage,
  isDaemonOrigin,
} from '../../src/handlers/profile-register';

describe('applyProfileRegister', () => {
  it('persists supersurf_profile and does not close the registration tab', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn().mockResolvedValue(undefined);

    await applyProfileRegister('684f7687', 42, { local: { get: vi.fn(), set } }, { remove });

    expect(set).toHaveBeenCalledWith({ supersurf_profile: '684f7687' });
    expect(remove).not.toHaveBeenCalled();
  });
});

/** A promise whose settlement the test controls, so ordering is observable. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeDeps(set: (items: Record<string, unknown>) => any) {
  const remove = vi.fn().mockResolvedValue(undefined);
  const log = vi.fn();
  const get = vi.fn().mockResolvedValue({});
  return { deps: { storage: { local: { get, set } }, tabs: { remove }, log }, remove, log, get };
}

const REGISTER = { type: 'profileRegister', profile: '684f7687' };
/** The daemon's own registration page on the default port — the only allowed source. */
const SENDER = { tab: { id: 42 }, origin: 'http://127.0.0.1:5555' };

/** Let queued microtasks (the handler's .then/.catch chain) run. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('handleProfileRegisterMessage', () => {
  it('replies { ok: true } once the storage write resolves', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    const { deps } = makeDeps(set);
    const sendResponse = vi.fn();

    handleProfileRegisterMessage(REGISTER, SENDER, sendResponse, deps);
    await flush();

    expect(set).toHaveBeenCalledWith({ supersurf_profile: '684f7687' });
    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });

  it('replies { ok: false } when the storage write rejects', async () => {
    const set = vi.fn().mockRejectedValue(new Error('quota exceeded'));
    const { deps, log } = makeDeps(set);
    const sendResponse = vi.fn();

    handleProfileRegisterMessage(REGISTER, SENDER, sendResponse, deps);
    await flush();

    // Silence on the failure path is the bug: the page then blames a timeout.
    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ ok: false });
    expect(log).toHaveBeenCalled();
  });

  it('does not reply until the storage write has settled', async () => {
    const gate = deferred();
    const set = vi.fn(() => gate.promise);
    const { deps } = makeDeps(set);
    const sendResponse = vi.fn();

    handleProfileRegisterMessage(REGISTER, SENDER, sendResponse, deps);
    await flush();

    // Pre-fix semantics: reply first, write later. "registered" would then mean
    // "the message was accepted", not "the binding is on disk".
    expect(set).toHaveBeenCalled();
    expect(sendResponse).not.toHaveBeenCalled();

    gate.resolve();
    await flush();

    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });

  it('does not reply ok early when the pending write later rejects', async () => {
    const gate = deferred();
    const set = vi.fn(() => gate.promise);
    const { deps } = makeDeps(set);
    const sendResponse = vi.fn();

    handleProfileRegisterMessage(REGISTER, SENDER, sendResponse, deps);
    await flush();
    expect(sendResponse).not.toHaveBeenCalled();

    gate.reject(new Error('disk full'));
    await flush();

    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ ok: false });
  });

  it('returns true to signal an async reply', () => {
    const set = vi.fn().mockResolvedValue(undefined);
    const { deps } = makeDeps(set);

    // Without `true` Chrome closes the port and the reply never lands.
    expect(handleProfileRegisterMessage(REGISTER, SENDER, vi.fn(), deps)).toBe(true);
  });

  it('does not handle a techStack message and returns undefined', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    const { deps } = makeDeps(set);
    const sendResponse = vi.fn();

    // Returning `true` here would leave the techStack port dangling.
    const result = handleProfileRegisterMessage(
      { type: 'techStack', data: { frameworks: [] } } as any,
      SENDER,
      sendResponse,
      deps,
    );
    await flush();

    expect(result).toBeUndefined();
    expect(set).not.toHaveBeenCalled();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('ignores unrelated, profile-less and malformed messages', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    const { deps } = makeDeps(set);
    const sendResponse = vi.fn();

    for (const message of [
      null,
      undefined,
      {} as any,
      { type: 'console' } as any,
      { type: 'profileRegister' } as any,
      { type: 'profileRegister', profile: '' } as any,
    ]) {
      expect(handleProfileRegisterMessage(message, SENDER, sendResponse, deps)).toBeUndefined();
    }
    await flush();

    expect(set).not.toHaveBeenCalled();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('survives a sender with no tab and a missing sendResponse', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    const { deps } = makeDeps(set);

    expect(
      handleProfileRegisterMessage(REGISTER, { origin: 'http://127.0.0.1:5555' }, undefined, deps),
    ).toBe(true);
    await flush();

    expect(set).toHaveBeenCalledWith({ supersurf_profile: '684f7687' });
  });

  it('refuses a sender with no tab and no origin', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    const { deps } = makeDeps(set);

    expect(handleProfileRegisterMessage(REGISTER, {}, undefined, deps)).toBe(true);
    await flush();

    expect(set).not.toHaveBeenCalled();
  });
});

describe('isDaemonOrigin', () => {
  it('accepts any loopback origin over http, regardless of port', () => {
    expect(isDaemonOrigin('http://127.0.0.1:5555')).toBe(true);
    // A non-default port is exactly what a daemon on SUPERSURF_PORT/--port uses.
    expect(isDaemonOrigin('http://127.0.0.1:7000')).toBe(true);
    expect(isDaemonOrigin('http://localhost:5555')).toBe(true);
    expect(isDaemonOrigin('http://[::1]:5555')).toBe(true);

    // https on loopback is not what the daemon serves.
    expect(isDaemonOrigin('https://127.0.0.1:5555')).toBe(false);
    // The bug this guards against: any page on the web reaching this handler.
    expect(isDaemonOrigin('https://evil.example')).toBe(false);
    expect(isDaemonOrigin('null')).toBe(false);
    expect(isDaemonOrigin(undefined)).toBe(false);
  });
});

describe('handleProfileRegisterMessage — origin guard', () => {
  it('refuses a page that is not the daemon registration page', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    const { deps, log } = makeDeps(set);
    const sendResponse = vi.fn();

    handleProfileRegisterMessage(
      REGISTER,
      { tab: { id: 42 }, origin: 'https://evil.example' },
      sendResponse,
      deps,
    );
    await flush();

    // The binding must not land, and the page must hear a refusal rather than
    // sit on its 15 s timeout with no explanation.
    expect(set).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith({ ok: false });
    expect(log).toHaveBeenCalled();
  });

  it('accepts a non-default daemon port', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    const { deps } = makeDeps(set);
    const sendResponse = vi.fn();

    handleProfileRegisterMessage(
      REGISTER,
      { tab: { id: 42 }, origin: 'http://127.0.0.1:7100' },
      sendResponse,
      deps,
    );
    await flush();

    expect(set).toHaveBeenCalledWith({ supersurf_profile: '684f7687' });
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });

  it('accepts localhost and [::1] loopback origins', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    const { deps } = makeDeps(set);
    const sendResponse = vi.fn();

    handleProfileRegisterMessage(
      REGISTER,
      { tab: { id: 42 }, origin: 'http://localhost:5555' },
      sendResponse,
      deps,
    );
    await flush();
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });

    const set2 = vi.fn().mockResolvedValue(undefined);
    const { deps: deps2 } = makeDeps(set2);
    const sendResponse2 = vi.fn();
    handleProfileRegisterMessage(
      REGISTER,
      { tab: { id: 42 }, origin: 'http://[::1]:5555' },
      sendResponse2,
      deps2,
    );
    await flush();
    expect(sendResponse2).toHaveBeenCalledWith({ ok: true });
  });

  it('falls back to sender.url when the runtime reports no origin', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    const { deps } = makeDeps(set);
    const sendResponse = vi.fn();

    handleProfileRegisterMessage(
      REGISTER,
      { tab: { id: 42 }, url: 'http://127.0.0.1:5555/register/684f7687' },
      sendResponse,
      deps,
    );
    await flush();

    expect(set).toHaveBeenCalledWith({ supersurf_profile: '684f7687' });
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });
});
