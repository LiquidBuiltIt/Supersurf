/**
 * Persist managed-profile binding from the daemon registration page.
 * Leaves the registration tab open so Chrome does not quit when it was the only tab.
 */

type StorageLocal = {
  local: {
    get: (keys: string | string[]) => Promise<Record<string, any>>;
    set: (items: Record<string, unknown>) => Promise<void> | void;
  };
};

type TabsApi = {
  remove: (tabId: number) => Promise<void> | void;
};

export async function applyProfileRegister(
  profile: string,
  _tabId: number | undefined,
  storage: StorageLocal,
  _tabs: TabsApi,
): Promise<void> {
  await storage.local.set({ supersurf_profile: profile });
  // Do not auto-close the registration tab (default). Closing the last tab
  // would quit Chromium and drop the extension WebSocket mid-connect.
}

/** Fallback when `mcpPort` was never written to storage. Mirrors websocket.ts. */
const DEFAULT_PORT = '5555';

/**
 * Is this the daemon's own registration page?
 *
 * The daemon serves `/register/:name` on loopback at the configured port and
 * spawns Chromium straight at that URL (`daemon/src/profiles/chrome.ts`), so
 * that one origin is the only legitimate source of a binding request.
 *
 * Origin is the check because the transport cannot be one: the content script
 * relays a `window.postMessage`, and its `event.source !== window` guard passes
 * for any page posting to itself — that is, every page on the web. Before this
 * check, visiting a hostile site was enough to rebind the managed profile.
 * `sender.origin` comes from Chrome, not from the page, so it cannot be forged.
 */
export function isDaemonOrigin(origin: string | undefined, port: string): boolean {
  return !!origin && origin === `http://127.0.0.1:${port}`;
}

/**
 * The sender's origin. `origin` is Chrome 80+; `url` is the long-standing
 * fallback so an older or non-Chrome runtime degrades to the same answer
 * instead of refusing every registration.
 */
function senderOrigin(sender: { origin?: string; url?: string } | null | undefined): string | undefined {
  if (sender?.origin) return sender.origin;
  try {
    return sender?.url ? new URL(sender.url).origin : undefined;
  } catch {
    return undefined;
  }
}

/** Dependencies the message handler needs; injected so tests need no browser. */
export type ProfileRegisterDeps = {
  storage: StorageLocal;
  tabs: TabsApi;
  log?: (...args: unknown[]) => void;
};

/**
 * `chrome.runtime.onMessage` handler for the `profileRegister` message.
 *
 * Returns `true` when it took the message, which keeps the message port open
 * for the async reply. Returns `undefined` for anything else, so unrelated
 * branches (e.g. `techStack`) do not leave a dangling port.
 *
 * The reply must report the *storage write*, not merely that the message was
 * received: the content script relays it to the registration page, which shows
 * a failure state unless it hears that the binding actually landed.
 */
export function handleProfileRegisterMessage(
  message: { type?: string; profile?: string } | null | undefined,
  sender: { tab?: { id?: number }; origin?: string; url?: string } | null | undefined,
  sendResponse: ((response: { ok: boolean }) => void) | undefined,
  deps: ProfileRegisterDeps,
): true | undefined {
  if (message?.type !== 'profileRegister' || !message.profile) return undefined;

  const origin = senderOrigin(sender);
  const profile = message.profile;

  (async () => {
    const port = String((await deps.storage.local.get('mcpPort'))?.mcpPort || DEFAULT_PORT);
    if (!isDaemonOrigin(origin, port)) {
      deps.log?.(
        '[Background] Profile register refused —',
        origin ?? '(unknown origin)',
        'is not the daemon registration page',
      );
      sendResponse?.({ ok: false });
      return;
    }
    await applyProfileRegister(profile, sender?.tab?.id, deps.storage, deps.tabs);
    sendResponse?.({ ok: true });
  })().catch((e) => {
    deps.log?.('[Background] Profile register failed:', e);
    sendResponse?.({ ok: false });
  });

  return true;
}
