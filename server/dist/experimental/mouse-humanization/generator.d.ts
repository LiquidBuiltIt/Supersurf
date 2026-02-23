/**
 * Path generator — cubic Bezier trajectories with overshoot correction.
 *
 * Produces waypoint arrays that the extension replays via CDP Input.dispatchMouseEvent.
 * Each waypoint has an (x, y) position and a delay in ms before dispatch.
 *
 * Algorithm overview:
 * 1. Compute travel distance; micro-corrections (<5px) get a single waypoint.
 * 2. Derive duration from distance, velocity (with log-normal noise), and personality speed.
 * 3. Decide overshoot: if distance > threshold and random < personality.overshootTendency,
 *    generate a two-segment path (arc past target + correction arc back).
 * 4. Each segment is a cubic Bezier with control points offset perpendicular to the
 *    movement vector (same side for natural hand arc).
 * 5. Sample at irregular intervals with jitter applied to each waypoint.
 * 6. Clamp all coordinates to viewport bounds.
 *
 * @module experimental/mouse-humanization/generator
 *
 * Key exports:
 * - {@link generatePath} — main entry point for path generation
 * - {@link Waypoint} — position + delay for a single mouse event
 * - {@link Viewport} — width/height bounds for coordinate clamping
 */
import type { DistributionProfile } from './profile';
import type { MousePersonality } from './personality';
export interface Waypoint {
    x: number;
    y: number;
    /** Delay in ms before dispatching this waypoint */
    delayMs: number;
}
export interface Viewport {
    width: number;
    height: number;
}
/**
 * Generate a human-like mouse path from (fromX, fromY) to (toX, toY).
 *
 * @param fromX - Starting X coordinate
 * @param fromY - Starting Y coordinate
 * @param toX - Target X coordinate
 * @param toY - Target Y coordinate
 * @param profile - Statistical distribution profile (velocity, overshoot thresholds, etc.)
 * @param personality - Per-session behavioral traits (speed, curvature, jitter)
 * @param viewport - Viewport dimensions for coordinate clamping
 * @returns Array of waypoints to replay as mouse events
 */
export declare function generatePath(fromX: number, fromY: number, toX: number, toY: number, profile: DistributionProfile, personality: MousePersonality, viewport: Viewport): Waypoint[];
//# sourceMappingURL=generator.d.ts.map