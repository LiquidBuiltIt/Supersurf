/**
 * Persist managed-profile binding from the daemon registration page.
 * Leaves the registration tab open so Chrome does not quit when it was the only tab.
 */
export async function applyProfileRegister(profile, _tabId, storage, _tabs) {
    await storage.local.set({ supersurf_profile: profile });
    // Do not auto-close the registration tab (default). Closing the last tab
    // would quit Chromium and drop the extension WebSocket mid-connect.
}
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
/**
 * Is this the daemon's own registration page?
 *
 * The daemon serves `/register/:name` on loopback (`daemon/src/profiles/chrome.ts`
 * spawns Chromium straight at that URL), so any loopback origin over http is
 * accepted regardless of port. No web page can ever hold a loopback origin, so
 * pinning a specific port did not keep out anything an attacker could reach;
 * and anyone able to bind a port on this machine already has local code
 * execution. The port check was never the load-bearing part of this guard —
 * `sender.origin` is supplied by Chrome, not the page, so it cannot be
 * forged, and that is what actually keeps a hostile web page out.
 */
export function isDaemonOrigin(origin) {
    if (!origin)
        return false;
    let url;
    try {
        url = new URL(origin);
    }
    catch {
        return false;
    }
    return url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(url.hostname);
}
/**
 * The sender's origin. `origin` is Chrome 80+; `url` is the long-standing
 * fallback so an older or non-Chrome runtime degrades to the same answer
 * instead of refusing every registration.
 */
function senderOrigin(sender) {
    if (sender?.origin)
        return sender.origin;
    try {
        return sender?.url ? new URL(sender.url).origin : undefined;
    }
    catch {
        return undefined;
    }
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
    const origin = senderOrigin(sender);
    const profile = message.profile;
    (async () => {
        if (!isDaemonOrigin(origin)) {
            deps.log?.('[Background] Profile register refused —', origin ?? '(unknown origin)', 'is not the daemon registration page');
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
