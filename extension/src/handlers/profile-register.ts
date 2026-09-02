/**
 * Persist managed-profile binding from the daemon registration page.
 * Leaves the registration tab open so Chrome does not quit when it was the only tab.
 */

type StorageLocal = {
  local: {
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
  sender: { tab?: { id?: number } } | null | undefined,
  sendResponse: ((response: { ok: boolean }) => void) | undefined,
  deps: ProfileRegisterDeps,
): true | undefined {
  if (message?.type !== 'profileRegister' || !message.profile) return undefined;

  applyProfileRegister(message.profile, sender?.tab?.id, deps.storage, deps.tabs)
    .then(() => sendResponse?.({ ok: true }))
    .catch((e) => {
      deps.log?.('[Background] Profile register failed:', e);
      sendResponse?.({ ok: false });
    });

  return true;
}
