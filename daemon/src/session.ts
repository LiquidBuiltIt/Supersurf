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
export class SessionRegistry {
  private sessions: Map<string, DaemonSession> = new Map();

  /** Register a new session. Returns false if sessionId already exists. */
  add(sessionId: string, socket: net.Socket): boolean {
    if (this.sessions.has(sessionId)) return false;
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
  remove(sessionId: string): DaemonSession | undefined {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.sessions.delete(sessionId);
    }
    return session;
  }

  /** Get a session by ID. */
  get(sessionId: string): DaemonSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Check if a session exists. */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Return the number of active sessions. */
  get count(): number {
    return this.sessions.size;
  }

  /** Return all session IDs. */
  ids(): string[] {
    return [...this.sessions.keys()];
  }

  /** Iterate over all sessions. */
  values(): IterableIterator<DaemonSession> {
    return this.sessions.values();
  }

  /** Set the attached tab ID for a session. */
  setAttachedTabId(sessionId: string, tabId: number | null): void {
    const session = this.sessions.get(sessionId);
    if (session) session.attachedTabId = tabId;
  }

  /** Get the attached tab ID for a session. */
  getAttachedTabId(sessionId: string): number | null {
    return this.sessions.get(sessionId)?.attachedTabId ?? null;
  }

  /** Set the group ID for a session. */
  setGroupId(sessionId: string, groupId: number | null): void {
    const session = this.sessions.get(sessionId);
    if (session) session.groupId = groupId;
  }

  /** Add a tab to a session's ownership set. */
  addOwnedTab(sessionId: string, tabId: number): void {
    const session = this.sessions.get(sessionId);
    if (session) session.ownedTabs.add(tabId);
  }

  /** Remove a tab from a session's ownership set. */
  removeOwnedTab(sessionId: string, tabId: number): void {
    const session = this.sessions.get(sessionId);
    if (session) session.ownedTabs.delete(tabId);
  }

  /** Find which session owns a tab by its ID. Returns null if unowned. */
  findTabOwner(tabId: number): string | null {
    for (const session of this.sessions.values()) {
      if (session.ownedTabs.has(tabId)) return session.sessionId;
    }
    return null;
  }

  /** Set the profile ID for a session. */
  setProfileId(sessionId: string, profileId: string | null): void {
    const session = this.sessions.get(sessionId);
    if (session) session.profileId = profileId;
  }

  /** Get the profile ID for a session. */
  getProfileId(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.profileId ?? null;
  }

  /** Get all sessions connected to a specific profile. */
  getSessionsForProfile(profileId: string): DaemonSession[] {
    const result: DaemonSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.profileId === profileId) result.push(session);
    }
    return result;
  }

  /** Get all tab IDs owned by sessions other than the given one. */
  getOtherOwnedTabIds(sessionId: string): Set<number> {
    const result = new Set<number>();
    for (const [sid, session] of this.sessions) {
      if (sid === sessionId) continue;
      for (const tabId of session.ownedTabs) {
        result.add(tabId);
      }
    }
    return result;
  }
}
