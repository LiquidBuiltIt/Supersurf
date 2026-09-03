/**
 * Persist managed-profile binding from the daemon registration page.
 * Leaves the registration tab open so Chrome does not quit when it was the only tab.
 */
export async function applyProfileRegister(profile, _tabId, storage, _tabs) {
    await storage.local.set({ supersurf_profile: profile });
    // Do not auto-close the registration tab (default). Closing the last tab
    // would quit Chromium and drop the extension WebSocket mid-connect.
}
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
export function handleProfileRegisterMessage(message, sender, sendResponse, deps) {
    if (message?.type !== 'profileRegister' || !message.profile)
        return undefined;
    applyProfileRegister(message.profile, sender?.tab?.id, deps.storage, deps.tabs)
        .then(() => sendResponse?.({ ok: true }))
        .catch((e) => {
        deps.log?.('[Background] Profile register failed:', e);
        sendResponse?.({ ok: false });
    });
    return true;
}
