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
