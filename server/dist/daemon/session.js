"use strict";
/**
 * Session registry — tracks connected MCP sessions and their tab ownership.
 *
 * @module session
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionRegistry = void 0;
/**
 * Manages the set of active MCP sessions connected to the daemon.
 * Each session owns a socket, a set of tabs, and an attached tab ID.
 */
class SessionRegistry {
    sessions = new Map();
    /** Register a new session. Returns false if sessionId already exists. */
    add(sessionId, socket) {
        if (this.sessions.has(sessionId))
            return false;
        this.sessions.set(sessionId, {
            sessionId,
            socket,
            ownedTabs: new Set(),
            attachedTabId: null,
            groupId: null,
            profileId: null,
        });
        return true;
    }
    /** Remove a session by ID. Returns the removed session or undefined. */
    remove(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
            this.sessions.delete(sessionId);
        }
        return session;
    }
    /** Get a session by ID. */
    get(sessionId) {
        return this.sessions.get(sessionId);
    }
    /** Check if a session exists. */
    has(sessionId) {
        return this.sessions.has(sessionId);
    }
    /** Return the number of active sessions. */
    get count() {
        return this.sessions.size;
    }
    /** Return all session IDs. */
    ids() {
        return [...this.sessions.keys()];
    }
    /** Iterate over all sessions. */
    values() {
        return this.sessions.values();
    }
    /** Set the attached tab ID for a session. */
    setAttachedTabId(sessionId, tabId) {
        const session = this.sessions.get(sessionId);
        if (session)
            session.attachedTabId = tabId;
    }
    /** Get the attached tab ID for a session. */
    getAttachedTabId(sessionId) {
        return this.sessions.get(sessionId)?.attachedTabId ?? null;
    }
    /** Set the group ID for a session. */
    setGroupId(sessionId, groupId) {
        const session = this.sessions.get(sessionId);
        if (session)
            session.groupId = groupId;
    }
    /** Add a tab to a session's ownership set. */
    addOwnedTab(sessionId, tabId) {
        const session = this.sessions.get(sessionId);
        if (session)
            session.ownedTabs.add(tabId);
    }
    /** Remove a tab from a session's ownership set. */
    removeOwnedTab(sessionId, tabId) {
        const session = this.sessions.get(sessionId);
        if (session)
            session.ownedTabs.delete(tabId);
    }
    /** Find which session owns a tab by its ID. Returns null if unowned. */
    findTabOwner(tabId) {
        for (const session of this.sessions.values()) {
            if (session.ownedTabs.has(tabId))
                return session.sessionId;
        }
        return null;
    }
    /** Set the profile ID for a session. */
    setProfileId(sessionId, profileId) {
        const session = this.sessions.get(sessionId);
        if (session)
            session.profileId = profileId;
    }
    /** Get the profile ID for a session. */
    getProfileId(sessionId) {
        return this.sessions.get(sessionId)?.profileId ?? null;
    }
    /** Get all sessions connected to a specific profile. */
    getSessionsForProfile(profileId) {
        const result = [];
        for (const session of this.sessions.values()) {
            if (session.profileId === profileId)
                result.push(session);
        }
        return result;
    }
    /** Get all tab IDs owned by sessions other than the given one. */
    getOtherOwnedTabIds(sessionId) {
        const result = new Set();
        for (const [sid, session] of this.sessions) {
            if (sid === sessionId)
                continue;
            for (const tabId of session.ownedTabs) {
                result.add(tabId);
            }
        }
        return result;
    }
}
exports.SessionRegistry = SessionRegistry;
//# sourceMappingURL=session.js.map