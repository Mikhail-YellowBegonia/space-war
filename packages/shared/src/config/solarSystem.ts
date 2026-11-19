import type { CelestialBody } from '../types/index.js';

export const SOLAR_GLARE_CONFIG = {
  /** Half-angle of the sunward glare cone in radians (~25 degrees). */
  coneHalfAngleRad: (25 * Math.PI) / 180,
  /** Minimum sensitivity multiplier when looking directly toward the Sun. */
  minSensitivityFactor: 0.1,
} as const;

/**
 * Inner solar system topology: Sun + 10 planets/asteroids projected onto the 2D ecliptic plane.
 * Semi-major axes and eccentricities follow real ratios; radii are exaggerated to 0.025-0.055 AU
 * for tactical occlusion, umbra geometry, and visual clarity.
 */
export const SOLAR_SYSTEM_BODIES: readonly CelestialBody[] = [
  {
    id: 'sun',
    name: 'Sun',
    orbit: null,
    visualRadiusAu: 0.055,
    occlusionRadiusAu: 0.055,
    umbraLengthAu: 0,
    yields: {},
  },
  {
    id: 'mercury',
    name: 'Mercury',
    orbit: {
      a: 0.39,
      e: 0.206,
      omega: 0.52,
      meanAnomaly0: 1.9,
      epochSec: 0,
    },
    visualRadiusAu: 0.028,
    occlusionRadiusAu: 0.025,
    umbraLengthAu: 0.16,
    yields: { ore: 3.6 },
  },
  {
    id: 'venus',
    name: 'Venus',
    orbit: {
      a: 0.72,
      e: 0.007,
      omega: 1.15,
      meanAnomaly0: 4.1,
      epochSec: 0,
    },
    visualRadiusAu: 0.036,
    occlusionRadiusAu: 0.032,
    umbraLengthAu: 0.24,
    yields: { ore: 2.5, propellant: 0.6 },
  },
  {
    id: 'earth',
    name: 'Earth',
    orbit: {
      a: 1.0,
      e: 0.017,
      omega: 0,
      meanAnomaly0: 0,
      epochSec: 0,
    },
    visualRadiusAu: 0.04,
    occlusionRadiusAu: 0.036,
    umbraLengthAu: 0.3,
    yields: { ore: 1.2, propellant: 1.0 },
    ownerSlot: 'earth',
  },
  {
    id: 'eros',
    name: '433 Eros',
    orbit: {
      a: 1.32,
      e: 0.18,
      omega: 0.35,
      meanAnomaly0: 0.42,
      epochSec: 0,
    },
    visualRadiusAu: 0.025,
    occlusionRadiusAu: 0.025,
    umbraLengthAu: 0.2,
    yields: { ore: 2.2, propellant: 2.0 },
  },
  {
    id: 'mars',
    name: 'Mars',
    orbit: {
      a: 1.52,
      e: 0.093,
      omega: 0.2,
      meanAnomaly0: 0.75,
      epochSec: 0,
    },
    visualRadiusAu: 0.036,
    occlusionRadiusAu: 0.032,
    umbraLengthAu: 0.28,
    yields: { ore: 1.2, propellant: 1.1 },
    ownerSlot: 'mars',
  },
  {
    id: 'vesta',
    name: '4 Vesta',
    orbit: {
      a: 2.36,
      e: 0.089,
      omega: 2.4,
      meanAnomaly0: 5.1,
      epochSec: 0,
    },
    visualRadiusAu: 0.027,
    occlusionRadiusAu: 0.025,
    umbraLengthAu: 0.22,
    yields: { ore: 2.8, propellant: 0.8 },
  },
  {
    id: 'ceres',
    name: '1 Ceres',
    orbit: {
      a: 2.77,
      e: 0.076,
      omega: 1.4,
      meanAnomaly0: 2.1,
      epochSec: 0,
    },
    visualRadiusAu: 0.034,
    occlusionRadiusAu: 0.03,
    umbraLengthAu: 0.28,
    yields: { ore: 1.2, propellant: 3.8 },
  },
  {
    id: 'pallas',
    name: '2 Pallas',
    orbit: {
      a: 2.77,
      e: 0.231,
      omega: 4.5,
      meanAnomaly0: 5.3,
      epochSec: 0,
    },
    visualRadiusAu: 0.027,
    occlusionRadiusAu: 0.025,
    umbraLengthAu: 0.22,
    yields: { ore: 2.6, propellant: 1.4 },
  },
  {
    id: 'psyche',
    name: '16 Psyche',
    orbit: {
      a: 2.92,
      e: 0.134,
      omega: 3.1,
      meanAnomaly0: 0.95,
      epochSec: 0,
    },
    visualRadiusAu: 0.026,
    occlusionRadiusAu: 0.025,
    umbraLengthAu: 0.22,
    yields: { ore: 4.2 },
  },
  {
    id: 'hygiea',
    name: '10 Hygiea',
    orbit: {
      a: 3.14,
      e: 0.112,
      omega: 5.2,
      meanAnomaly0: 3.6,
      epochSec: 0,
    },
    visualRadiusAu: 0.027,
    occlusionRadiusAu: 0.025,
    umbraLengthAu: 0.24,
    yields: { ore: 1.8, propellant: 3.2 },
  },
] as const;

export const CELESTIAL_BODIES_BY_ID: Readonly<Record<string, CelestialBody>> = Object.fromEntries(
  SOLAR_SYSTEM_BODIES.map((body) => [body.id, body]),
);
