# Multi-Agent Connection Fixes — Implementation Plan

Four changes to make multi-agent sessions reliable. Ordered by dependency and impact.

---

## 1. Remove Server Idle Timeout

**Problem:** The MCP server kills the daemon connection after 120s of inactivity. Agents that pause to think lose their session.

**Goal:** The connection lives indefinitely. Only torn down by: (a) MCP client killing the server process (stdin close), (b) user clicking disconnect in extension popup, or (c) explicit `disconnect` tool call.

### Files to modify

#### `server/src/cli.ts`

**Delete the idle timeout constant and function (lines 158-189):**

```typescript
// DELETE ENTIRELY — lines 158-189
/** Idle timeout — shuts down the server if no tool calls for 120s while active. */
const IDLE_TIMEOUT_MS = 120_000;

function setupIdleTimeout(backend: ConnectionManager): void {
  // ... entire function body
}
```

**Delete the `setupIdleTimeout` call (line 237):**

```typescript
// DELETE this line:
setupIdleTimeout(backend);
```

So line 237 becomes just:

```typescript
setupExitWatchdog(backend, server);
// (no setupIdleTimeout call)
```

### Edge cases

- The daemon's own 10-minute idle timeout (`daemon/src/main.ts` line 39) should **stay**. It only fires when zero sessions are connected — it's process lifecycle cleanup, not session management.
- `setupExitWatchdog` (lines 123-156) stays untouched — it handles process signals and stdin close, which are the correct teardown triggers.

### Testing

- Run the server, connect, wait >2 minutes with no tool calls, then call a tool. It should succeed without needing to reconnect.
- Existing test: `server/tests/backend.test.ts` — verify no tests rely on idle timeout behavior. The idle timeout is set up in `cli.ts` (not in `ConnectionManager`), so backend tests should be unaffected.
- Consider adding a test to `cli.ts` behavior if one doesn't exist, but this is a deletion — no new code to test.

---

## 2. Add Bidirectional Heartbeat (Server ↔ Daemon)

**Problem:** The Unix socket between `DaemonClient` (server) and `IPCServer` (daemon) has no keepalive. Silent socket death goes undetected until the next tool call fails.

**Goal:** 30-second heartbeat interval. Client sends `keepalive`, daemon responds with `keepalive_ack`. Two consecutive missed acks = connection dead → trigger reconnect/cleanup.

### Files to modify

#### `server/src/daemon-client.ts` — Send keepalives, track acks

**Add instance variables** (after line 37, near other private fields):

```typescript
private keepaliveInterval: ReturnType<typeof setInterval> | null = null;
private missedAcks: number = 0;
private static KEEPALIVE_INTERVAL_MS = 30_000;
private static MAX_MISSED_ACKS = 2;
```

**Start keepalive after handshake succeeds** — in the `start()` method, after `this._connected = true` (line 106), add:

```typescript
this._connected = true;
this.startKeepalive(); // <-- add this
```

**Handle `keepalive_ack` responses** — in the `socket.on('data')` handler, after the `session_reject` check (after line 116), add a new check before the JSON-RPC response handling:

```typescript
if (msg.type === 'keepalive_ack') {
  this.missedAcks = 0;
  continue;
}
```

**Add keepalive methods** (new private methods):

```typescript
/** Start sending periodic keepalive pings to the daemon. */
private startKeepalive(): void {
  this.stopKeepalive();
  this.missedAcks = 0;

  this.keepaliveInterval = setInterval(() => {
    if (!this._connected || !this.socket?.writable) {
      this.stopKeepalive();
      return;
    }

    this.missedAcks++;
    if (this.missedAcks > DaemonClient.MAX_MISSED_ACKS) {
      log('Daemon unresponsive — missed', this.missedAcks, 'keepalive acks. Closing connection.');
      this.stopKeepalive();
      this.cleanup();
      this._connected = false;
      this.drainInflight();
      return;
    }

    this.sendLine({ type: 'keepalive' });
  }, DaemonClient.KEEPALIVE_INTERVAL_MS);

  // Don't let keepalive keep the process alive
  this.keepaliveInterval.unref();
}

/** Stop the keepalive interval. */
private stopKeepalive(): void {
  if (this.keepaliveInterval) {
    clearInterval(this.keepaliveInterval);
    this.keepaliveInterval = null;
  }
}
```

**Stop keepalive on disconnect** — in the `stop()` method (line 198), add `this.stopKeepalive()`:

```typescript
async stop(): Promise<void> {
  log('Disconnecting from daemon');
  this.stopKeepalive(); // <-- add
  this.drainInflight();
  this.cleanup();
  this._connected = false;
}
```

**Stop keepalive on socket close** — in the `socket.on('close')` handler (line 141), add:

```typescript
this.socket.on('close', () => {
  log('Daemon connection closed');
  this._connected = false;
  this.stopKeepalive(); // <-- add
  this.drainInflight();
});
```

#### `daemon/src/ipc.ts` — Respond to keepalives

**In `handleConnection`**, in the `socket.on('data')` handler, after the handshake check (`if (!handshakeComplete)` block), add a keepalive check before JSON-RPC routing (inside the `else` branch on line 165):

```typescript
} else {
  // Keepalive — respond immediately, no session state changes
  if (msg.type === 'keepalive') {
    this.sendLine(socket, { type: 'keepalive_ack' });
    continue; // back to while loop — don't route to handleRequest
  }

  // Post-handshake: JSON-RPC 2.0 requests
  this.handleRequest(sessionId!, socket, msg);
}
```

The `continue` works because this is inside the `while ((newlineIdx = buffer.indexOf('\n')) !== -1)` loop.

### Edge cases

- **Keepalive during heavy tool execution:** The daemon processes keepalives inline in the data handler, before JSON-RPC routing. It's a simple write, no scheduling or async needed. Tool execution happens in `handleRequest` via the scheduler — keepalive responses won't block.
- **Unref:** The `keepaliveInterval.unref()` is critical. Without it, the keepalive timer keeps the server process alive even after stdin closes, preventing clean exit.
- **Socket close race:** If the socket fires `close` while a keepalive is being sent, the `writable` check in `sendLine` (line 426) prevents write-after-close errors.

### Testing

#### `server/tests/daemon-client.test.ts`

Add tests:
- Verify keepalive starts after successful handshake (mock socket, check for `{ type: 'keepalive' }` messages after interval)
- Verify `keepalive_ack` resets `missedAcks`
- Verify 2 consecutive missed acks trigger connection close
- Verify `stop()` clears the keepalive interval

#### `daemon/tests/ipc.test.ts`

Add test:
- Send `{ type: 'keepalive' }` on a handshaked session socket → verify `{ type: 'keepalive_ack' }` is written back
- Verify keepalive doesn't touch session state or scheduler

---

## 3. Ghost Sessions (Reconnect-and-Resume)

**Problem:** When the Unix socket closes (server process restart, network hiccup), the daemon destroys all session state — `attachedTabId`, `ownedTabs`, `groupId`. Reconnecting starts fresh.

**Goal:** On disconnect, keep session state as a "ghost" with a 5-minute TTL. If the same `sessionId` reconnects within that window, restore state and re-enter the scheduler. After TTL expires, do full cleanup.

### Files to modify

#### `daemon/src/types.ts` — Make socket nullable

**Line 12:** Change `socket: net.Socket` to `socket: net.Socket | null`:

```typescript
export interface DaemonSession {
  sessionId: string;
  socket: net.Socket | null;  // null = ghost session (disconnected, awaiting reconnect)
  ownedTabs: Set<number>;
  attachedTabId: number | null;
  groupId: number | null;
  profileId: string | null;
}
```

#### `daemon/src/session.ts` — Support ghost state

**Update `add()` (line 18-28):** Accept `net.Socket | null`:

```typescript
add(sessionId: string, socket: net.Socket | null): boolean {
```

**Add `setSocket()` method** (new method):

```typescript
/** Update the socket for an existing session (used for ghost session restoration). */
setSocket(sessionId: string, socket: net.Socket | null): void {
  const session = this.sessions.get(sessionId);
  if (session) session.socket = socket;
}
```

**Add `isGhost()` method** (new method):

```typescript
/** Check if a session is a ghost (disconnected but state preserved). */
isGhost(sessionId: string): boolean {
  const session = this.sessions.get(sessionId);
  return session !== null && session !== undefined && session.socket === null;
}
```

**Update `count` getter** to only count active (non-ghost) sessions:

```typescript
/** Return the number of active (non-ghost) sessions. */
get count(): number {
  let active = 0;
  for (const session of this.sessions.values()) {
    if (session.socket !== null) active++;
  }
  return active;
}

/** Return the total number of sessions including ghosts. */
get totalCount(): number {
  return this.sessions.size;
}
```

#### `daemon/src/ipc.ts` — Ghost on disconnect, restore on reconnect

**Add ghost TTL constant** (near top of file, after imports):

```typescript
/** How long to keep ghost session state before full cleanup (ms). */
const GHOST_TTL_MS = 5 * 60 * 1000; // 5 minutes
```

**Add ghost timer map** (private field on `IPCServer`):

```typescript
private ghostTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
```

**Replace socket `close` handler (lines 182-206)** — convert to ghost instead of destroying:

```typescript
socket.on('close', () => {
  if (sessionId) {
    debugLog(`Session disconnected: "${sessionId}" — converting to ghost`);

    // Remove from active scheduling but keep state
    this.scheduler.removeSession(sessionId);

    // Mark socket as null (ghost state) — keep ownedTabs, attachedTabId, groupId, profileId
    this.sessions.setSocket(sessionId!, null);

    // Start ghost TTL — full cleanup if no reconnect within 5 minutes
    const timer = setTimeout(() => {
      this.ghostTimers.delete(sessionId!);
      if (this.sessions.isGhost(sessionId!)) {
        debugLog(`Ghost TTL expired for "${sessionId}" — full cleanup`);
        const profileId = this.sessions.getProfileId(sessionId!);
        if (profileId) {
          this.sessions.setProfileId(sessionId!, null);
        }
        this.sessions.remove(sessionId!);
        this.experiments.deleteSession(sessionId!);

        // Notify extension to ungroup the session's tabs
        if (profileId) {
          this.bridge.sendCmdToProfile(profileId, 'sessionDisconnect', { sessionId }, 5000).catch(() => {});
        } else {
          this.bridge.sendCmd('sessionDisconnect', { sessionId }, 5000).catch(() => {});
        }
      }
    }, GHOST_TTL_MS);
    timer.unref();
    this.ghostTimers.set(sessionId!, timer);

    if (this.onSessionCountChange) {
      this.onSessionCountChange(this.sessions.count);
    }
  }
});
```

**Update handshake in `handleConnection` (lines 129-157)** — check for ghost session before rejecting duplicate sessionId:

Replace the existing duplicate check (lines 132-138):

```typescript
if (this.sessions.has(sessionId!)) {
  this.sendLine(socket, {
    type: 'session_reject',
    reason: 'Session ID already in use',
  });
  socket.end();
  return;
}
```

With ghost-aware logic:

```typescript
if (this.sessions.has(sessionId!)) {
  // Check if it's a ghost session (awaiting reconnect)
  if (this.sessions.isGhost(sessionId!)) {
    // Restore ghost session
    debugLog(`Restoring ghost session: "${sessionId}"`);

    // Cancel the ghost TTL timer
    const ghostTimer = this.ghostTimers.get(sessionId!);
    if (ghostTimer) {
      clearTimeout(ghostTimer);
      this.ghostTimers.delete(sessionId!);
    }

    // Restore socket and re-enter scheduler
    this.sessions.setSocket(sessionId!, socket);
    this.scheduler.addSession(sessionId!);

    const session = this.sessions.get(sessionId!);
    const attachedTabId = session?.attachedTabId ?? null;

    this.sendLine(socket, {
      type: 'session_ack',
      browser: this.bridge.browser,
      buildTimestamp: this.bridge.buildTime,
      capabilities: { profiles: !!this.profileRegistry },
      restored: true,
      attachedTabId,
      ownedTabs: session ? [...session.ownedTabs] : [],
    });

    handshakeComplete = true;
    debugLog(`Ghost session restored: "${sessionId}", attachedTabId=${attachedTabId}`);

    if (this.onSessionCountChange) {
      this.onSessionCountChange(this.sessions.count);
    }
  } else {
    // Active session with same ID — reject
    this.sendLine(socket, {
      type: 'session_reject',
      reason: 'Session ID already in use',
    });
    socket.end();
    return;
  }
} else {
  // Brand new session — normal registration
  this.sessions.add(sessionId!, socket);
  this.scheduler.addSession(sessionId!);

  this.sendLine(socket, {
    type: 'session_ack',
    browser: this.bridge.browser,
    buildTimestamp: this.bridge.buildTime,
    capabilities: { profiles: !!this.profileRegistry },
  });

  handshakeComplete = true;
  debugLog(`Session registered: "${sessionId}"`);

  if (this.onSessionCountChange) {
    this.onSessionCountChange(this.sessions.count);
  }
}
```

**Update `stop()` method (lines 431-448)** — handle nullable sockets and clean up ghost timers:

```typescript
async stop(): Promise<void> {
  return new Promise((resolve) => {
    if (!this.server) {
      resolve();
      return;
    }

    // Cancel all ghost timers
    for (const timer of this.ghostTimers.values()) {
      clearTimeout(timer);
    }
    this.ghostTimers.clear();

    // Close all active session sockets
    for (const session of this.sessions.values()) {
      if (session.socket) {  // <-- null check for ghost sessions
        session.socket.end();
      }
    }

    this.server.close(() => {
      debugLog('IPC server stopped');
      resolve();
    });
  });
}
```

#### `server/src/daemon-client.ts` — Handle restored session ack

**In the `session_ack` handler (lines 101-109)**, parse the `restored` flag and extra fields:

```typescript
if (msg.type === 'session_ack') {
  clearTimeout(connectTimeout);
  this._browser = msg.browser || 'chrome';
  this._buildTime = msg.buildTimestamp || null;
  this._capabilities = msg.capabilities || null;
  this._connected = true;

  // Ghost session restoration
  if (msg.restored) {
    log(`Ghost session restored: "${this.sessionId}", attachedTabId=${msg.attachedTabId}`);
    this._restoredTabId = msg.attachedTabId ?? null;
    this._restoredOwnedTabs = msg.ownedTabs ?? [];
  }

  log(`Session registered: "${this.sessionId}", browser: ${this._browser}`);
  resolve();
  continue;
}
```

**Add properties for restored state:**

```typescript
private _restoredTabId: number | null = null;
private _restoredOwnedTabs: number[] = [];

/** Tab ID the session was attached to before disconnect (if ghost-restored). */
get restoredTabId(): number | null { return this._restoredTabId; }

/** Tab IDs the session owned before disconnect (if ghost-restored). */
get restoredOwnedTabs(): number[] { return this._restoredOwnedTabs; }
```

#### `server/src/backend.ts` — Auto-reattach on restored session

After connecting to the daemon in the `connect` tool handler, check for restored state and auto-reattach. The exact location depends on the `connect` flow in `backend.ts`, but the logic is:

```typescript
// After daemon.start() succeeds:
if (daemon.restoredTabId !== null) {
  log('Ghost session restored — auto-reattaching to tab', daemon.restoredTabId);
  // The daemon already has the session's attachedTabId set,
  // so the scheduler will auto context-switch on the next tool call.
  // Just update the server-side metadata:
  this.setAttachedTab({ id: daemon.restoredTabId });
}
```

### Edge cases

1. **Ghost's `ownedTabs` reference tabs that were closed during disconnect:** On restore, the daemon's `attachedTabId` may point to a tab that no longer exists. The scheduler's auto context-switch will call `selectTab` with that ID → the extension will throw `"No tab with id: X"`. The server should catch this and clear `attachedTabId`. **Alternatively**, validate tabs on restore by sending a `getTabs` check and filtering. But this is a nice-to-have — the error is recoverable.

2. **Ghost TTL vs daemon idle timeout:** Ghost TTL is 5 minutes. Daemon idle timeout is 10 minutes. But the daemon idle timeout counts sessions (via `onSessionCountChange`). With ghosts, `sessions.count` only counts active sessions (non-ghost). So if the last active session ghosts out, the daemon will see count=0 and start its 10-minute idle timer. If the ghost TTL (5 min) expires first, the ghost is cleaned up. If the server reconnects within 5 min, the ghost is restored and the daemon idle timer is cancelled. This ordering is correct.

3. **Race: old socket close arrives after new socket connects with same sessionId:** The ghost check in the handshake handles this — if the session already exists and is NOT a ghost (socket is still non-null), it rejects. If the old socket hasn't fired `close` yet, the new connection is rejected. To mitigate: the `DaemonClient.stop()` calls `socket.destroy()` which triggers close synchronously in the same event loop tick for Unix sockets. But if the MCP client kills the process hard (SIGKILL), the daemon may not see the close until TCP timeout. **Mitigation:** in the reject case, add a brief log suggesting retry.

4. **Experiment state during ghost:** The `experiments.deleteSession()` call is deferred to ghost TTL expiry. This means experiment toggles are preserved across reconnects. Good — the agent doesn't need to re-enable experiments.

### Testing

#### `daemon/tests/ipc.test.ts`

Add tests:
- **Ghost creation:** Connect session, close socket → verify `sessions.has(sessionId)` is true but `sessions.isGhost(sessionId)` is true
- **Ghost restoration:** Connect, disconnect, reconnect with same sessionId → verify `session_ack` includes `restored: true` and `attachedTabId`
- **Ghost TTL expiry:** Connect, disconnect, advance timers past 5 minutes → verify session is fully cleaned up
- **Active session rejection:** Two sockets with same sessionId simultaneously → verify second is rejected with "Session ID already in use"

#### `daemon/tests/session.test.ts`

Add tests:
- `setSocket()` updates socket reference
- `isGhost()` returns true when socket is null, false otherwise
- `count` only counts non-ghost sessions
- `totalCount` counts all sessions

#### `server/tests/daemon-client.test.ts`

Add tests:
- Verify `restoredTabId` and `restoredOwnedTabs` are parsed from `session_ack` with `restored: true`

---

## 4. Tab ID-Based Attach/Close

**Problem:** The `browser_tabs` MCP schema only exposes `index` for attach/close. Tab indices shift when any tab is opened or closed — unreliable in multi-agent scenarios.

**Goal:** Add `tab_id` parameter to the schema. The extension already handles `tabId` natively (confirmed: `extension/src/handlers/tabs.ts` line 260-265). The gap is only in the MCP schema and server navigation handler.

### Files to modify

#### `server/src/tools/schemas.ts` — Add `tab_id` to schema

**In the `browser_tabs` tool schema (lines 22-45)**, add `tab_id` to `properties` after the `index` property (line 35):

```typescript
index: { type: 'number', description: 'Tab index (for attach/close actions)' },
tab_id: { type: 'number', description: 'Tab ID (for attach/close actions). More stable than index — IDs don\'t shift when tabs are opened/closed.' },
```

#### `server/src/tools/navigation.ts` — Pass `tabId` to extension commands

**In `onBrowserTabs` (lines 22-59)**, update the `attach` and `close` cases to pass `tabId`:

Replace the `attach` case (lines 37-40):

```typescript
case 'attach':
  result = await ctx.ext.sendCmd('selectTab', {
    index: args.index,
    tabId: args.tab_id,     // <-- add
    stealth: args.stealth,
  });
  break;
```

Replace the `close` case (lines 42-43):

```typescript
case 'close':
  result = await ctx.ext.sendCmd('closeTab', args.tab_id ?? args.index);
  break;
```

**Note:** The extension's `selectTab` (line 260) already handles `{ index?: number; tabId?: number }`. It checks `tabId` first, falls back to `index` (lines 263-274). So passing both is fine — `tabId` takes priority when present.

For `closeTab`, check how the extension handles it — if it accepts an object with `tabId`, adjust accordingly. If it accepts a raw number (tab index), and tab ID needs different handling, verify the extension's `closeTab` implementation:

```typescript
// Verify in extension/src/handlers/tabs.ts — closeTab signature
// If it accepts { index?, tabId? }, pass as object:
case 'close':
  result = await ctx.ext.sendCmd('closeTab', {
    index: args.index,
    tabId: args.tab_id,
  });
  break;
```

### Edge cases

- **Both `index` and `tab_id` provided:** `tabId` takes priority in the extension handler (line 263 checks `tabId` first). Document this in the schema description or handle it server-side with a validation error.
- **Neither provided:** Extension throws `"Either tabId or index is required"` (line 274). This error propagates cleanly.
- **`tab_id` for `list` or `new` actions:** Ignored — only relevant for `attach` and `close`. No validation needed.

### Testing

#### `server/tests/tools-navigation.test.ts`

Add tests:
- `browser_tabs` with `action: 'attach', tab_id: 12345` → verify `selectTab` called with `{ tabId: 12345 }`
- `browser_tabs` with `action: 'close', tab_id: 12345` → verify `closeTab` called with tab ID
- `browser_tabs` with `action: 'attach', index: 0` → verify backwards compat still works
- `browser_tabs` with `action: 'attach', tab_id: 12345, index: 0` → verify `tabId` takes priority

---

## Summary

| Change | Files | Complexity | Dependencies |
|--------|-------|------------|--------------|
| 1. Remove idle timeout | `server/src/cli.ts` | ~30 lines deleted | None |
| 2. Heartbeat | `server/src/daemon-client.ts`, `daemon/src/ipc.ts` | ~50 lines added | None (but pair with #1) |
| 3. Ghost sessions | `daemon/src/types.ts`, `daemon/src/session.ts`, `daemon/src/ipc.ts`, `server/src/daemon-client.ts`, `server/src/backend.ts` | ~120 lines changed | None (but benefits from #2) |
| 4. Tab ID attach | `server/src/tools/schemas.ts`, `server/src/tools/navigation.ts` | ~10 lines changed | None |

Build order: `npm run build.shared && npm run build.daemon && npm run build.server`
Test: `npm run test` (all packages)
