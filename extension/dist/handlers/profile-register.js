/**
 * Persist managed-profile binding from the daemon registration page.
 * Leaves the registration tab open so Chrome does not quit when it was the only tab.
 */
export async function applyProfileRegister(profile, _tabId, storage, _tabs) {
    await storage.local.set({ supersurf_profile: profile });
    // Do not auto-close the registration tab (default). Closing the last tab
    // would quit Chromium and drop the extension WebSocket mid-connect.
}
