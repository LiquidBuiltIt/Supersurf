# TODO

## Bug: Popup windows break all `browser_tabs` operations

**Error:** `"Tabs can only be moved to and from normal windows."`

When a popup window exists in the Chrome profile (e.g. Google Sign-in popup), ALL tab operations (`attach`, `new`, `close`) fail across every window — not just the popup. This is because `tabs.query({})` returns tabs from all window types, and Chrome throws when you try to move/reindex tabs involving popup windows.

### Fix: Filter `tabs.query({})` to normal windows

Every `tabs.query({})` call needs `{ windowType: 'normal' }` to exclude popup, panel, and devtools windows:

| Location | Function | Line |
|----------|----------|------|
| `extension/src/handlers/tabs.ts` | `getTabs` | ~183 |
| `extension/src/handlers/tabs.ts` | `selectTab` | ~268 |
| `extension/src/handlers/tabs.ts` | `closeTab` | ~332 |
| `extension/src/handlers/tabs.ts` | `handleSessionDisconnect` | ~156 |

All four are the same change: `tabs.query({})` → `tabs.query({ windowType: 'normal' })`.

### Bonus: Expose `tabId` in schema

The extension's `selectTab` handler already supports `tabId`, but the server schema and handler don't pass it through. Adding it would give agents a more robust way to attach to specific tabs without relying on index ordering.

1. **Schema** (`server/src/tools/schemas.ts`, ~line 35): Add `tabId: { type: 'number', description: 'Tab ID (alternative to index)' }` to `browser_tabs` properties.
2. **Handler** (`server/src/tools/navigation.ts`, ~line 37-39): Pass `tabId: args.tabId` in the `selectTab` command alongside `index`.
