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
import { type DistributionProfile } from './profile';
import { type MousePersonality } from './personality';
import { type Waypoint, type Viewport } from './generator';
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
/** Initialize a new humanization session with a random personality. */
export declare function initSession(sessionId: string, profile?: DistributionProfile): void;
/** Get a session, returns undefined if not initialized. */
export declare function getSession(sessionId: string): HumanizationSession | undefined;
/** Destroy a session on disable/disconnect. */
export declare function destroySession(sessionId: string): void;
/**
 * Generate a humanized mouse movement path for a session.
 * Updates the session's cursor position to the target.
 */
export declare function generateMovement(sessionId: string, targetX: number, targetY: number, viewport: Viewport): Waypoint[];
//# sourceMappingURL=index.d.ts.map