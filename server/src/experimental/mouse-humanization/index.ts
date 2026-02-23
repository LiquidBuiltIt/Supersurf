/**
 * Mouse humanization session orchestrator.
 *
 * Each MCP session gets its own humanization session with a random personality
 * (speed, overshoot tendency, curvature, jitter) and tracked cursor position.
 * When a mouse movement is requested, this module delegates to the path generator
 * and updates the session's cursor state.
 *
 * Lifecycle: initSession() on experiment enable -> generateMovement() per interaction -> destroySession() on disable.
 *
 * @module experimental/mouse-humanization/index
 *
 * Key exports:
 * - {@link initSession} — create a session with a random personality
 * - {@link getSession} — retrieve session state
 * - {@link destroySession} — clean up on disconnect/disable
 * - {@link generateMovement} — produce a waypoint path from current cursor to target
 */

import { BALABIT_PROFILE, type DistributionProfile } from './profile';
import { generatePersonality, type MousePersonality } from './personality';
import { generatePath, type Waypoint, type Viewport } from './generator';
import { createLog } from '../../logger';

const log = createLog('[Mouse]');

export type { DistributionProfile } from './profile';
export type { MousePersonality } from './personality';
export type { Waypoint, Viewport } from './generator';
export { BALABIT_PROFILE } from './profile';
export { generatePersonality } from './personality';
export { generatePath } from './generator';

/** Per-session state: personality traits, current cursor position, and the distribution profile in use. */
interface HumanizationSession {
  personality: MousePersonality;
  cursorX: number;
  cursorY: number;
  profile: DistributionProfile;
}

/** Active humanization sessions keyed by session ID. */
const sessions = new Map<string, HumanizationSession>();

/** Initialize a new humanization session with a random personality. */
export function initSession(sessionId: string, profile?: DistributionProfile): void {
  const personality = generatePersonality();
  sessions.set(sessionId, {
    personality,
    cursorX: 0,
    cursorY: 0,
    profile: profile ?? BALABIT_PROFILE,
  });
  log(`Session "${sessionId}" initialized — speed=${personality.speedMultiplier.toFixed(2)}, overshoot=${personality.overshootTendency.toFixed(2)}, curvature=${personality.curvatureBias.toFixed(2)}, jitter=${personality.jitterPx.toFixed(2)}px`);
}

/** Get a session, returns undefined if not initialized. */
export function getSession(sessionId: string): HumanizationSession | undefined {
  return sessions.get(sessionId);
}

/** Destroy a session on disable/disconnect. */
export function destroySession(sessionId: string): void {
  sessions.delete(sessionId);
  log(`Session "${sessionId}" destroyed`);
}

/**
 * Generate a humanized mouse movement path for a session.
 * Updates the session's cursor position to the target.
 */
export function generateMovement(
  sessionId: string,
  targetX: number,
  targetY: number,
  viewport: Viewport
): Waypoint[] {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`No humanization session for "${sessionId}"`);
  }

  const fromX = session.cursorX;
  const fromY = session.cursorY;
  const dx = targetX - fromX;
  const dy = targetY - fromY;
  const distance = Math.sqrt(dx * dx + dy * dy);

  const waypoints = generatePath(
    fromX,
    fromY,
    targetX,
    targetY,
    session.profile,
    session.personality,
    viewport
  );

  const overshoot = distance > session.profile.overshootThreshold;
  log(`Path (${fromX},${fromY})→(${targetX},${targetY}) dist=${Math.round(distance)}px waypoints=${waypoints.length} overshoot=${overshoot}`);

  // Update cursor position
  session.cursorX = targetX;
  session.cursorY = targetY;

  return waypoints;
}
