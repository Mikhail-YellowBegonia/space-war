import { describe, expect, it } from 'vitest';
import {
  CELESTIAL_BODIES_BY_ID,
  MU_SUN,
  SOLAR_GLARE_CONFIG,
  SOLAR_SYSTEM_BODIES,
  getBodyStateAt,
  getOrbitalPeriodSec,
  getSolarGlareFactor,
  isInUmbra,
  isOccluded,
  orbitToState,
  solveKeplerEquation,
  type KeplerOrbit,
} from '../src/index.js';

describe('SW-03 inner solar system ephemeris and occlusion/umbra geometry', () => {
  it('defines the Sun plus all 10 inner solar system bodies with valid radii and faction slots', () => {
    expect(SOLAR_SYSTEM_BODIES).toHaveLength(11);

    const expectedIds = [
      'sun',
      'mercury',
      'venus',
      'earth',
      'eros',
      'mars',
      'vesta',
      'ceres',
      'pallas',
      'psyche',
      'hygiea',
    ];
    expect(SOLAR_SYSTEM_BODIES.map((b) => b.id)).toEqual(expectedIds);

    expect(CELESTIAL_BODIES_BY_ID.sun.orbit).toBeNull();
    expect(CELESTIAL_BODIES_BY_ID.earth.ownerSlot).toBe('earth');
    expect(CELESTIAL_BODIES_BY_ID.mars.ownerSlot).toBe('mars');

    for (const body of SOLAR_SYSTEM_BODIES) {
      expect(body.visualRadiusAu).toBeGreaterThanOrEqual(0.025);
      expect(body.visualRadiusAu).toBeLessThanOrEqual(0.055);
      expect(body.occlusionRadiusAu).toBeGreaterThanOrEqual(0.025);
      expect(body.occlusionRadiusAu).toBeLessThanOrEqual(0.055);
      if (body.orbit !== null) {
        expect(body.umbraLengthAu).toBeGreaterThan(0);
      }
    }
  });

  it('keeps 1 AU circular orbital period strictly equal to 252 s', () => {
    expect(getOrbitalPeriodSec(1.0)).toBeCloseTo(252, 12);

    const unitCircular: KeplerOrbit = {
      a: 1.0,
      e: 0,
      omega: 0,
      meanAnomaly0: 0,
      epochSec: 0,
    };

    const s0 = orbitToState(unitCircular, 0);
    const sQuarter = orbitToState(unitCircular, 63);
    const sHalf = orbitToState(unitCircular, 126);
    const sFull = orbitToState(unitCircular, 252);

    expect(s0.pos.x).toBeCloseTo(1, 12);
    expect(s0.pos.y).toBeCloseTo(0, 12);
    expect(sQuarter.pos.x).toBeCloseTo(0, 12);
    expect(sQuarter.pos.y).toBeCloseTo(1, 12);
    expect(sHalf.pos.x).toBeCloseTo(-1, 12);
    expect(sHalf.pos.y).toBeCloseTo(0, 12);
    expect(sFull.pos.x).toBeCloseTo(1, 12);
    expect(sFull.pos.y).toBeCloseTo(0, 12);
    expect(sFull.vel.x).toBeCloseTo(s0.vel.x, 12);
    expect(sFull.vel.y).toBeCloseTo(s0.vel.y, 12);
  });

  it('solves Kepler equation accurately and preserves orbital energy across eccentric orbits', () => {
    for (const e of [0, 0.206, 0.231, 0.85]) {
      for (const m of [-2.7, -0.4, 0.05, 1.3, 2.9]) {
        const E = solveKeplerEquation(m, e);
        expect(E - e * Math.sin(E) - m).toBeCloseTo(0, 10);
      }
    }

    const mercury = CELESTIAL_BODIES_BY_ID.mercury;
    const period = getOrbitalPeriodSec(mercury.orbit!.a);
    expect(period).toBeCloseTo(61.38, 1);

    const expectedEnergy = -MU_SUN / (2 * mercury.orbit!.a);
    const s0 = getBodyStateAt(mercury, 0);
    const sEnd = getBodyStateAt(mercury, period);

    for (const t of [0, period * 0.25, period * 0.6, period]) {
      const state = getBodyStateAt(mercury, t);
      const r = Math.hypot(state.pos.x, state.pos.y);
      const vSq = state.vel.x * state.vel.x + state.vel.y * state.vel.y;
      const specificEnergy = 0.5 * vSq - MU_SUN / r;
      expect(specificEnergy).toBeCloseTo(expectedEnergy, 10);
    }

    expect(sEnd.pos.x).toBeCloseTo(s0.pos.x, 10);
    expect(sEnd.pos.y).toBeCloseTo(s0.pos.y, 10);

    const sunState = getBodyStateAt(CELESTIAL_BODIES_BY_ID.sun, 1234);
    expect(sunState).toEqual({ pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 } });
  });

  it('computes finite anti-sunward tangent-cone umbra boundaries accurately', () => {
    const testBody = [
      {
        id: 'sun',
        pos: { x: 0, y: 0 },
        occlusionRadiusAu: 0.055,
        umbraLengthAu: 0,
      },
      {
        id: 'earth',
        pos: { x: 1.0, y: 0 },
        occlusionRadiusAu: 0.04,
        umbraLengthAu: 0.3,
      },
    ];

    // Directly behind Earth inside umbraLengthAu
    expect(isInUmbra({ x: 1.1, y: 0 }, testBody)).toBe(true);
    // Expanding tangent cone slightly wider than planet radius (halfWidth at 1.2 is ~0.04804)
    expect(isInUmbra({ x: 1.2, y: 0.045 }, testBody)).toBe(true);
    // Outside tangent cone laterally
    expect(isInUmbra({ x: 1.2, y: 0.055 }, testBody)).toBe(false);
    // Sunlit side of Earth
    expect(isInUmbra({ x: 0.9, y: 0 }, testBody)).toBe(false);
    // Beyond umbraLengthAu behind Earth
    expect(isInUmbra({ x: 1.31, y: 0 }, testBody)).toBe(false);
    // Inside umbra right before cap
    expect(isInUmbra({ x: 1.29, y: 0 }, testBody)).toBe(true);

    // Dynamic ephemeris evaluation at t = 126 s (Earth moves to ~(-1, 0))
    const earthAtHalf = getBodyStateAt(CELESTIAL_BODIES_BY_ID.earth, 126).pos;
    const behindEarthAtHalf = {
      x: earthAtHalf.x * 1.1,
      y: earthAtHalf.y * 1.1,
    };
    const inFrontOfEarthAtHalf = {
      x: earthAtHalf.x * 0.9,
      y: earthAtHalf.y * 0.9,
    };
    expect(isInUmbra(behindEarthAtHalf, SOLAR_SYSTEM_BODIES, 126)).toBe(true);
    expect(isInUmbra(inFrontOfEarthAtHalf, SOLAR_SYSTEM_BODIES, 126)).toBe(false);
  });

  it('detects line-of-sight occlusion accurately across segment and boundary edge cases', () => {
    const bodies = [
      {
        id: 'sun',
        pos: { x: 0, y: 0 },
        occlusionRadiusAu: 0.055,
      },
      {
        id: 'rock',
        pos: { x: 1.0, y: 0 },
        occlusionRadiusAu: 0.05,
      },
    ];

    // Crosses through rock center
    expect(isOccluded({ x: 0.8, y: 0 }, { x: 1.2, y: 0 }, bodies)).toBe(true);
    // Crosses off-center interior (closest approach = 0.03 < 0.05)
    expect(isOccluded({ x: 0.8, y: 0.03 }, { x: 1.2, y: 0.03 }, bodies)).toBe(true);
    // Clears rock (closest approach = 0.06 > 0.05)
    expect(isOccluded({ x: 0.8, y: 0.06 }, { x: 1.2, y: 0.06 }, bodies)).toBe(false);
    // Rock lies beyond segment endpoint (not between observer and target)
    expect(isOccluded({ x: 0.5, y: 0 }, { x: 0.9, y: 0 }, bodies)).toBe(false);
    // Surface boundary looking outward does not self-occlude
    expect(isOccluded({ x: 1.05, y: 0 }, { x: 1.5, y: 0 }, bodies)).toBe(false);
    // Zero-length segment
    expect(isOccluded({ x: 1.0, y: 0 }, { x: 1.0, y: 0 }, bodies)).toBe(false);
    // Opposite sides of the Sun are occluded by the Sun at any tSec
    expect(isOccluded({ x: -1.0, y: 0 }, { x: 1.0, y: 0 }, SOLAR_SYSTEM_BODIES, 0)).toBe(true);
  });

  it('computes solar glare attenuation smoothly within the sunward viewing cone', () => {
    const observer = { x: 1.0, y: 0 };

    // Target directly toward the Sun (theta = 0)
    const deadAhead = getSolarGlareFactor(observer, { x: 0.4, y: 0 });
    expect(deadAhead).toBeCloseTo(SOLAR_GLARE_CONFIG.minSensitivityFactor, 12);

    // Target inside cone (~10 deg off Sun line)
    const tenDegRad = (10 * Math.PI) / 180;
    const insideCone = getSolarGlareFactor(observer, {
      x: 1.0 - 0.5 * Math.cos(tenDegRad),
      y: 0.5 * Math.sin(tenDegRad),
    });
    expect(insideCone).toBeGreaterThan(SOLAR_GLARE_CONFIG.minSensitivityFactor);
    expect(insideCone).toBeLessThan(1);

    // Target outside cone (35 deg off Sun line)
    const thirtyFiveDegRad = (35 * Math.PI) / 180;
    const outsideCone = getSolarGlareFactor(observer, {
      x: 1.0 - 0.5 * Math.cos(thirtyFiveDegRad),
      y: 0.5 * Math.sin(thirtyFiveDegRad),
    });
    expect(outsideCone).toBe(1);

    // Target away from the Sun
    expect(getSolarGlareFactor(observer, { x: 1.6, y: 0 })).toBe(1);
  });
});
