import { TIME_SCALE_CONFIG } from '../config/index.js';
import type { CelestialBody, KeplerOrbit, Vec2 } from '../types/index.js';

const TWO_PI = 2 * Math.PI;
const MAX_KEPLER_ECCENTRICITY = 0.92;
const MAX_KEPLER_ITERATIONS = 6;

/**
 * Standard gravitational parameter of the Sun in internal units (AU^3 / game_s^2).
 * Chosen so a 1.0 AU circular orbit has an exact period of 252 game seconds.
 */
export const MU_SUN =
  (4 * Math.PI * Math.PI) /
  (TIME_SCALE_CONFIG.gameSecondsPerEarthYear * TIME_SCALE_CONFIG.gameSecondsPerEarthYear);

export interface OrbitalState {
  pos: Vec2;
  vel: Vec2;
}

/**
 * Normalizes an angle into [0, 2*pi).
 */
export function normalizeAngle(rad: number): number {
  const wrapped = rad % TWO_PI;
  return wrapped < 0 ? wrapped + TWO_PI : wrapped;
}

function wrapSignedPi(rad: number): number {
  let wrapped = (rad + Math.PI) % TWO_PI;
  if (wrapped < 0) {
    wrapped += TWO_PI;
  }
  return wrapped - Math.PI;
}

/**
 * Computes the Keplerian orbital period in game seconds for a given semi-major axis (AU).
 */
export function getOrbitalPeriodSec(semiMajorAxisAu: number): number {
  if (semiMajorAxisAu <= 0) {
    throw new RangeError(`semiMajorAxisAu must be positive, got ${semiMajorAxisAu}`);
  }
  return TWO_PI * Math.sqrt((semiMajorAxisAu * semiMajorAxisAu * semiMajorAxisAu) / MU_SUN);
}

/**
 * Solves Kepler's equation M = E - e * sin(E) using up to 6 Newton-Raphson iterations.
 * Eccentricity is clamped below 0.92 for bounded convergence time and numerical stability.
 */
export function solveKeplerEquation(meanAnomalyRad: number, eccentricity: number): number {
  const e = Math.max(0, Math.min(MAX_KEPLER_ECCENTRICITY, eccentricity));
  const m = wrapSignedPi(meanAnomalyRad);

  if (e === 0) {
    return m;
  }

  let E = m + e * Math.sin(m);
  for (let i = 0; i < MAX_KEPLER_ITERATIONS; i++) {
    const f = E - e * Math.sin(E) - m;
    const fPrime = 1 - e * Math.cos(E);
    const delta = f / fPrime;
    E -= delta;
    if (Math.abs(delta) < 1e-12) {
      break;
    }
  }
  return E;
}

/**
 * Evaluates heliocentric 2D position (AU) and velocity (AU/s) for a Keplerian orbit at tSec.
 */
export function orbitToState(orbit: KeplerOrbit, tSec: number): OrbitalState {
  const a = orbit.a;
  if (a <= 0) {
    throw new RangeError(`KeplerOrbit.a must be positive, got ${a}`);
  }

  const e = Math.max(0, Math.min(MAX_KEPLER_ECCENTRICITY, orbit.e));
  const meanMotion = Math.sqrt(MU_SUN / (a * a * a));
  const meanAnomaly = orbit.meanAnomaly0 + meanMotion * (tSec - orbit.epochSec);
  const E = solveKeplerEquation(meanAnomaly, e);

  const cosE = Math.cos(E);
  const sinE = Math.sin(E);
  const sqrtOneMinusESq = Math.sqrt(1 - e * e);
  const r = a * (1 - e * cosE);

  const xOrb = a * (cosE - e);
  const yOrb = a * sqrtOneMinusESq * sinE;

  const vFactor = Math.sqrt(MU_SUN * a) / r;
  const vxOrb = -vFactor * sinE;
  const vyOrb = vFactor * sqrtOneMinusESq * cosE;

  const cosW = Math.cos(orbit.omega);
  const sinW = Math.sin(orbit.omega);

  return {
    pos: {
      x: xOrb * cosW - yOrb * sinW,
      y: xOrb * sinW + yOrb * cosW,
    },
    vel: {
      x: vxOrb * cosW - vyOrb * sinW,
      y: vxOrb * sinW + vyOrb * cosW,
    },
  };
}

/**
 * Returns a celestial body's heliocentric position (AU) and velocity (AU/s) at game time tSec.
 * The central Sun (orbit === null) remains stationary at the origin.
 */
export function getBodyStateAt(body: CelestialBody, tSec: number): OrbitalState {
  if (body.orbit === null) {
    return {
      pos: { x: 0, y: 0 },
      vel: { x: 0, y: 0 },
    };
  }
  return orbitToState(body.orbit, tSec);
}
