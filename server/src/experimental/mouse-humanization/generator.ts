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
export function generatePath(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  profile: DistributionProfile,
  personality: MousePersonality,
  viewport: Viewport
): Waypoint[] {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const distance = Math.sqrt(dx * dx + dy * dy);

  // Micro-correction: distance < 5px → single waypoint
  if (distance < 5) {
    return [{ x: clampX(toX, viewport), y: clampY(toY, viewport), delayMs: randomInterval(profile) }];
  }

  // Duration = distance / velocity. Velocity varies per-move via log-normal noise
  // to simulate natural speed inconsistency (Fitts's law deviations).
  const velocity = profile.medianVelocity * personality.speedMultiplier * logNormalNoise(profile.velocitySigma);
  const durationMs = Math.max(50, (distance / velocity) * 1000);

  // Decide whether to overshoot
  const shouldOvershoot =
    distance > profile.overshootThreshold &&
    Math.random() < personality.overshootTendency;

  let waypoints: Waypoint[];

  if (shouldOvershoot) {
    // Two-segment path: arc past target, then correction arc back
    const overshootFraction = profile.overshootRange[0] +
      Math.random() * (profile.overshootRange[1] - profile.overshootRange[0]);

    // Overshoot point: extend past target along the movement vector,
    // then add a small perpendicular offset so the overshoot isn't perfectly collinear.
    const overshootDist = distance * overshootFraction;
    const angle = Math.atan2(dy, dx);
    const perpAngle = angle + (Math.random() < 0.5 ? Math.PI / 2 : -Math.PI / 2);
    const perpOffset = overshootDist * 0.3 * (Math.random() - 0.5);

    const overshootX = toX + Math.cos(angle) * overshootDist + Math.cos(perpAngle) * perpOffset;
    const overshootY = toY + Math.sin(angle) * overshootDist + Math.sin(perpAngle) * perpOffset;

    // First arc: from → overshoot (70% of duration)
    const arc1Duration = durationMs * 0.7;
    const arc1 = sampleBezier(
      fromX, fromY, overshootX, overshootY,
      profile, personality, arc1Duration, viewport
    );

    // Second arc: overshoot → target (30% of duration)
    const arc2Duration = durationMs * 0.3;
    const arc2 = sampleBezier(
      overshootX, overshootY, toX, toY,
      profile, personality, arc2Duration, viewport
    );

    waypoints = [...arc1, ...arc2];
  } else {
    // Single cubic Bezier
    waypoints = sampleBezier(
      fromX, fromY, toX, toY,
      profile, personality, durationMs, viewport
    );
  }

  // Ensure the last waypoint is exactly the target
  if (waypoints.length > 0) {
    const last = waypoints[waypoints.length - 1];
    last.x = clampX(toX, viewport);
    last.y = clampY(toY, viewport);
  }

  return waypoints;
}

/**
 * Sample points along a cubic Bezier curve.
 *
 * Control points are placed perpendicular to the movement vector, both on the
 * same randomly-chosen side, producing a natural hand-arc effect. The `spread`
 * factor (profile.controlPointSpread * personality.curvatureBias) controls how
 * much the path bows away from a straight line.
 *
 * Points are sampled at irregular time intervals (randomInterval) to avoid the
 * unnaturally uniform spacing that bots typically produce.
 */
function sampleBezier(
  x0: number, y0: number,
  x1: number, y1: number,
  profile: DistributionProfile,
  personality: MousePersonality,
  durationMs: number,
  viewport: Viewport
): Waypoint[] {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.sqrt(dx * dx + dy * dy);

  // Perpendicular direction to movement vector (rotate 90 degrees)
  const perpX = -dy;
  const perpY = dx;
  const spread = profile.controlPointSpread * personality.curvatureBias;
  const side = Math.random() < 0.5 ? 1 : -1;

  // Place CP1 at ~33% and CP2 at ~66% along the line, offset perpendicular.
  // The (0.5 + random * 0.5) factor adds asymmetry between the two control points.
  const cp1x = x0 + dx * 0.33 + perpX * spread * side * (0.5 + Math.random() * 0.5);
  const cp1y = y0 + dy * 0.33 + perpY * spread * side * (0.5 + Math.random() * 0.5);
  const cp2x = x0 + dx * 0.66 + perpX * spread * side * (0.5 + Math.random() * 0.5);
  const cp2y = y0 + dy * 0.66 + perpY * spread * side * (0.5 + Math.random() * 0.5);

  // Sample at irregular intervals
  const waypoints: Waypoint[] = [];
  let elapsed = 0;

  while (elapsed < durationMs) {
    const interval = randomInterval(profile);
    elapsed += interval;
    if (elapsed >= durationMs) break;

    const t = elapsed / durationMs;
    const point = cubicBezier(t, x0, y0, cp1x, cp1y, cp2x, cp2y, x1, y1);

    // Apply jitter
    const jx = (Math.random() - 0.5) * 2 * personality.jitterPx;
    const jy = (Math.random() - 0.5) * 2 * personality.jitterPx;

    waypoints.push({
      x: clampX(point.x + jx, viewport),
      y: clampY(point.y + jy, viewport),
      delayMs: interval,
    });
  }

  // Final point at t=1
  waypoints.push({
    x: clampX(x1, viewport),
    y: clampY(y1, viewport),
    delayMs: Math.max(5, durationMs - elapsed),
  });

  return waypoints;
}

/** Evaluate cubic Bezier B(t) = (1-t)^3*P0 + 3(1-t)^2*t*P1 + 3(1-t)*t^2*P2 + t^3*P3 */
function cubicBezier(
  t: number,
  x0: number, y0: number,
  cp1x: number, cp1y: number,
  cp2x: number, cp2y: number,
  x1: number, y1: number
): { x: number; y: number } {
  const u = 1 - t;
  const u2 = u * u;
  const u3 = u2 * u;
  const t2 = t * t;
  const t3 = t2 * t;

  return {
    x: u3 * x0 + 3 * u2 * t * cp1x + 3 * u * t2 * cp2x + t3 * x1,
    y: u3 * y0 + 3 * u2 * t * cp1y + 3 * u * t2 * cp2y + t3 * y1,
  };
}

/** Random interval from profile's sample range */
function randomInterval(profile: DistributionProfile): number {
  const [min, max] = profile.sampleIntervalMs;
  return min + Math.random() * (max - min);
}

/**
 * Generate log-normal noise centered around 1.0 with the given sigma.
 * Uses Box-Muller transform to produce a normally-distributed Z,
 * then exponentiates to get the log-normal value: exp(Z * sigma).
 * This models the natural variation in human movement speed.
 */
function logNormalNoise(sigma: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  // Box-Muller: two uniform randoms -> one standard normal
  const z = Math.sqrt(-2 * Math.log(Math.max(u1, 1e-10))) * Math.cos(2 * Math.PI * u2);
  return Math.exp(z * sigma);
}

/** Clamp and round X to [0, viewport.width-1]. */
function clampX(x: number, viewport: Viewport): number {
  return Math.max(0, Math.min(Math.round(x), viewport.width - 1));
}

/** Clamp and round Y to [0, viewport.height-1]. */
function clampY(y: number, viewport: Viewport): number {
  return Math.max(0, Math.min(Math.round(y), viewport.height - 1));
}
