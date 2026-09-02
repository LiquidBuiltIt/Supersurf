/**
 * Content-script side of managed-profile registration.
 *
 * The daemon's registration page posts `register-profile` to its own window.
 * This relay forwards it to the service worker and, only once the worker
 * confirms the storage write, posts `register-profile-ack` back so the page can
 * clear its 15 s failure timeout.
 *
 * Kept in its own module, free of import-time side effects, because
 * `content-script.ts` is injected at `document_start` on every page.
 */
/**
 * Retry budget. On a fresh install the MV3 service worker may still be spinning
 * up, so a first send can fail outright. Attempt 1 fires immediately and each
 * retry is a further RELAY_RETRY_MS later, so the last attempt starts at
 * (RELAY_MAX_ATTEMPTS - 1) * RELAY_RETRY_MS = 12 s. That has to stay under the
 * registration page's 15 s timeout, otherwise the relay gives up early and the
 * page sits there blaming the extension for seconds after we stopped trying.
 * Fixed interval, not backoff — a slow worker start is worth re-probing often.
 */
export const RELAY_MAX_ATTEMPTS = 25;
export const RELAY_RETRY_MS = 500;
/**
 * Handle a `register-profile` page message.
 *
 * @returns `true` when the event was a registration request and the relay took
 *          it, `false` when the event was not ours.
 */
export function handleProfileRegisterRelay(event, deps) {
    const data = event?.data;
    if (!data || data.__supersurf !== true || data.action !== 'register-profile' || !data.profile) {
        return false;
    }
    const profile = data.profile;
    // Reply only to the page that asked. '*' would leak the ack to any
    // main-world script listening on this window.
    const replyOrigin = event.origin ?? '';
    const msg = { type: 'profileRegister', profile };
    let attempts = 0;
    const ack = () => {
        // The registration page waits on this and shows a failure state without
        // it. Only sent once the storage write actually completed — "registered"
        // has to mean the binding is on disk, not that a message was accepted.
        try {
            deps.postMessage({ __supersurf: true, action: 'register-profile-ack', profile }, replyOrigin);
        }
        catch {
            // A page with an opaque origin cannot be replied to; nothing to do.
        }
    };
    const retry = () => {
        if (++attempts < RELAY_MAX_ATTEMPTS)
            deps.setTimeout(trySend, RELAY_RETRY_MS);
    };
    const trySend = () => {
        try {
            deps.runtime.sendMessage(msg, (res) => {
                // No listener / service worker asleep — Chrome closes the port and
                // sets lastError. Retry; the worker may still be spinning up.
                if (deps.runtime.lastError) {
                    retry();
                    return;
                }
                // A negative reply means the write failed. Do NOT ack — the page's
                // failure state is exactly the right outcome there.
                if (res?.ok)
                    ack();
            });
        }
        catch {
            retry();
        }
    };
    trySend();
    return true;
}
