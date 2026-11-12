import { describe, it, expect, beforeEach } from 'vitest';
import {
  generatePersonality,
  generatePath,
  BALABIT_PROFILE,
  initSession,
  getSession,
  destroySession,
  generateMovement,
} from '../src/experimental/mouse-humanization/index';
import type { MousePersonality } from '../src/experimental/mouse-humanization/personality';
import type { Viewport } from '../src/experimental/mouse-humanization/generator';

const VIEWPORT: Viewport = { width: 1920, height: 1080 };

// ── Profile constants ────────────────────────────────────────────

describe('BALABIT_PROFILE', () => {
  it('has expected median velocity', () => {
    expect(BALABIT_PROFILE.medianVelocity).toBe(180);
  });

  it('has expected overshoot threshold', () => {
    expect(BALABIT_PROFILE.overshootThreshold).toBe(200);
  });

  it('has expected sample interval range', () => {
    expect(BALABIT_PROFILE.sampleIntervalMs).toEqual([15, 50]);
  });

  it('has expected idle drift range', () => {
    expect(BALABIT_PROFILE.idleDriftPx).toEqual([2, 5]);
    expect(BALABIT_PROFILE.idleDriftIntervalSec).toEqual([10, 30]);
  });
});

// ── Personality generation ───────────────────────────────────────

describe('generatePersonality()', () => {
  it('returns a personality within expected ranges', () => {
    // Run several times to check bounds
    for (let i = 0; i < 50; i++) {
      const p = generatePersonality();
      expect(p.speedMultiplier).toBeGreaterThanOrEqual(0.7);
      expect(p.speedMultiplier).toBeLessThanOrEqual(1.3);
      expect(p.overshootTendency).toBeGreaterThanOrEqual(0.3);
      expect(p.overshootTendency).toBeLessThanOrEqual(0.8);
      expect(p.curvatureBias).toBeGreaterThanOrEqual(0.3);
      expect(p.curvatureBias).toBeLessThanOrEqual(0.7);
      expect(p.jitterPx).toBeGreaterThanOrEqual(0.5);
      expect(p.jitterPx).toBeLessThanOrEqual(2.0);
    }
  });

  it('generates different personalities on each call', () => {
    const p1 = generatePersonality();
    const p2 = generatePersonality();
    // Very unlikely to be identical
    expect(
      p1.speedMultiplier === p2.speedMultiplier &&
      p1.overshootTendency === p2.overshootTendency
    ).toBe(false);
  });
});

// ── Path generation ──────────────────────────────────────────────

describe('generatePath()', () => {
  const personality: MousePersonality = {
    speedMultiplier: 1.0,
    overshootTendency: 0.5,
    curvatureBias: 0.5,
    jitterPx: 1.0,
  };

  it('returns single waypoint for micro-correction (< 5px)', () => {
    const path = generatePath(100, 100, 102, 101, BALABIT_PROFILE, personality, VIEWPORT);
    expect(path.length).toBe(1);
    expect(path[0].x).toBe(102);
    expect(path[0].y).toBe(101);
  });

  it('returns multiple waypoints for normal distance', () => {
    const path = generatePath(0, 0, 500, 500, BALABIT_PROFILE, personality, VIEWPORT);
    expect(path.length).toBeGreaterThan(1);
  });

  it('ends at the target coordinates', () => {
    const path = generatePath(0, 0, 300, 400, BALABIT_PROFILE, personality, VIEWPORT);
    const last = path[path.length - 1];
    expect(last.x).toBe(300);
    expect(last.y).toBe(400);
  });

  it('clamps waypoints to viewport bounds', () => {
    const smallViewport: Viewport = { width: 100, height: 100 };
    const path = generatePath(0, 0, 90, 90, BALABIT_PROFILE, personality, smallViewport);
    for (const wp of path) {
      expect(wp.x).toBeGreaterThanOrEqual(0);
      expect(wp.x).toBeLessThan(100);
      expect(wp.y).toBeGreaterThanOrEqual(0);
      expect(wp.y).toBeLessThan(100);
    }
  });

  it('all waypoints have positive delays', () => {
    const path = generatePath(0, 0, 800, 600, BALABIT_PROFILE, personality, VIEWPORT);
    for (const wp of path) {
      expect(wp.delayMs).toBeGreaterThan(0);
    }
  });

  it('produces more waypoints for longer distances', () => {
    const shortPath = generatePath(0, 0, 50, 50, BALABIT_PROFILE, personality, VIEWPORT);
    const longPath = generatePath(0, 0, 1000, 800, BALABIT_PROFILE, personality, VIEWPORT);
    expect(longPath.length).toBeGreaterThan(shortPath.length);
  });
});

// ── Session lifecycle ────────────────────────────────────────────

describe('session management', () => {
  const SESSION_ID = 'test-session';

  beforeEach(() => {
    destroySession(SESSION_ID);
  });

  describe('initSession()', () => {
    it('creates a session with a random personality', () => {
      initSession(SESSION_ID);
      const session = getSession(SESSION_ID);
      expect(session).toBeDefined();
      expect(session!.personality.speedMultiplier).toBeGreaterThanOrEqual(0.7);
    });

    it('starts cursor at (0, 0)', () => {
      initSession(SESSION_ID);
      const session = getSession(SESSION_ID);
      expect(session!.cursorX).toBe(0);
      expect(session!.cursorY).toBe(0);
    });

    it('uses BALABIT_PROFILE by default', () => {
      initSession(SESSION_ID);
      const session = getSession(SESSION_ID);
      expect(session!.profile.medianVelocity).toBe(180);
    });
  });

  describe('getSession()', () => {
    it('returns undefined for non-existent session', () => {
      expect(getSession('nonexistent')).toBeUndefined();
    });
  });

  describe('destroySession()', () => {
    it('removes the session', () => {
      initSession(SESSION_ID);
      expect(getSession(SESSION_ID)).toBeDefined();
      destroySession(SESSION_ID);
      expect(getSession(SESSION_ID)).toBeUndefined();
    });
  });

  describe('generateMovement()', () => {
    it('returns waypoints and updates cursor position', () => {
      initSession(SESSION_ID);
      const waypoints = generateMovement(SESSION_ID, 500, 300, VIEWPORT);
      expect(waypoints.length).toBeGreaterThan(0);

      const session = getSession(SESSION_ID);
      expect(session!.cursorX).toBe(500);
      expect(session!.cursorY).toBe(300);
    });

    it('throws for non-existent session', () => {
      expect(() => generateMovement('missing', 0, 0, VIEWPORT)).toThrow('No humanization session');
    });

    it('uses updated cursor position for subsequent calls', () => {
      initSession(SESSION_ID);

      // First movement: 0,0 → 100,100
      generateMovement(SESSION_ID, 100, 100, VIEWPORT);

      // Second movement: should start from 100,100
      const wp2 = generateMovement(SESSION_ID, 103, 101, VIEWPORT);
      // Distance is < 5px, so should be micro-correction (1 waypoint)
      expect(wp2.length).toBe(1);
    });
  });
});
