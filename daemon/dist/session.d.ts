/**
 * Session registry — tracks connected MCP sessions and their tab ownership.
 *
 * @module session
 */
import type net from 'net';
import type { DaemonSession } from './types';
/**
 * Manages the set of active MCP sessions connected to the daemon.
 * Each session owns a socket, a set of tabs, and an attached tab ID.
 */
export declare class SessionRegistry {
    private sessions;
    /** Register a new session. Returns false if sessionId already exists. */
    add(sessionId: string, socket: net.Socket): boolean;
    /** Remove a session by ID. Returns the removed session or undefined. */
    remove(sessionId: string): DaemonSession | undefined;
    /** Get a session by ID. */
    get(sessionId: string): DaemonSession | undefined;
    /** Check if a session exists. */
    has(sessionId: string): boolean;
    /** Return the number of active sessions. */
    get count(): number;
    /** Return all session IDs. */
    ids(): string[];
    /** Iterate over all sessions. */
    values(): IterableIterator<DaemonSession>;
    /** Set the attached tab ID for a session. */
    setAttachedTabId(sessionId: string, tabId: number | null): void;
    /** Get the attached tab ID for a session. */
    getAttachedTabId(sessionId: string): number | null;
    /** Set the group ID for a session. */
    setGroupId(sessionId: string, groupId: number | null): void;
    /** Add a tab to a session's ownership set. */
    addOwnedTab(sessionId: string, tabId: number): void;
    /** Remove a tab from a session's ownership set. */
    removeOwnedTab(sessionId: string, tabId: number): void;
    /** Find which session owns a tab by its ID. Returns null if unowned. */
    findTabOwner(tabId: number): string | null;
    /** Set the profile ID for a session. */
    setProfileId(sessionId: string, profileId: string | null): void;
    /** Get the profile ID for a session. */
    getProfileId(sessionId: string): string | null;
    /** Get all sessions connected to a specific profile. */
    getSessionsForProfile(profileId: string): DaemonSession[];
    /** Get all tab IDs owned by sessions other than the given one. */
    getOtherOwnedTabIds(sessionId: string): Set<number>;
}
//# sourceMappingURL=session.d.ts.map