import {
  getBodyStateAt,
  getSpecificOrbitalEnergy,
  isOccluded,
  MAX_KEPLER_ECCENTRICITY,
  MU_SUN,
  normalizeAngle,
  orbitToState,
  stateToOrbit,
} from '../physics/index.js';
import type { CelestialBody, KeplerOrbit, Vec2 } from '../types/index.js';

export interface LambertSolution {
  v1: Vec2;
  v2: Vec2;
  orbit: KeplerOrbit;
}

const MIN_SOLAR_PERIAPSIS_AU = 0.062;
const MAX_TRANSFER_ECCENTRICITY = MAX_KEPLER_ECCENTRICITY - 0.01;
const SQRT_MU = Math.sqrt(MU_SUN);

function stumpffC(z: number): number {
  if (z > 1e-6) {
    const s = Math.sqrt(z);
    return (1 - Math.cos(s)) / z;
  }
  if (z < -1e-6) {
    const s = Math.sqrt(-z);
    return (Math.cosh(s) - 1) / -z;
  }
  return 0.5 - z / 24 + (z * z) / 720;
}

function stumpffS(z: number): number {
  if (z > 1e-6) {
    const s = Math.sqrt(z);
    return (s - Math.sin(s)) / (s * s * s);
  }
  if (z < -1e-6) {
    const s = Math.sqrt(-z);
    return (Math.sinh(s) - s) / (s * s * s);
  }
  return 1 / 6 - z / 120 + (z * z) / 5040;
}

function evaluateLambertY(r1: number, r2: number, A: number, z: number): number {
  const c = stumpffC(z);
  if (c <= 1e-12) {
    return -1;
  }
  return r1 + r2 + (A * (z * stumpffS(z) - 1)) / Math.sqrt(c);
}

function evaluateLambertTof(r1: number, r2: number, A: number, z: number): number | null {
  const c = stumpffC(z);
  if (c <= 1e-12) {
    return null;
  }
  const y = r1 + r2 + (A * (z * stumpffS(z) - 1)) / Math.sqrt(c);
  if (!(y > 0)) {
    return null;
  }
  const x = Math.sqrt(y / c);
  return (x * x * x * stumpffS(z) + A * Math.sqrt(y)) / SQRT_MU;
}

/**
 * Solves the 2D prograde single-revolution elliptical Lambert transfer problem from `r1` to `r2`
 * over `dtSec`. Returns null if the trajectory is degenerate, hyperbolic, collides with the Sun,
 * or exceeds MAX_KEPLER_ECCENTRICITY.
 */
export function solveLambertTransfer(
  r1Vec: Vec2,
  r2Vec: Vec2,
  dtSec: number,
  t0Sec = 0,
): LambertSolution | null {
  const r1 = Math.hypot(r1Vec.x, r1Vec.y);
  const r2 = Math.hypot(r2Vec.x, r2Vec.y);
  if (r1 <= 1e-6 || r2 <= 1e-6 || dtSec <= 1e-4) {
    return null;
  }

  const theta1 = Math.atan2(r1Vec.y, r1Vec.x);
  const theta2 = Math.atan2(r2Vec.y, r2Vec.x);
  const dTheta = normalizeAngle(theta2 - theta1);

  // Reject collinear 0 / 2*pi or exact 180-deg geometry singularities (adjacent grid points resolve)
  if (dTheta < 1e-3 || dTheta > 2 * Math.PI - 1e-3 || Math.abs(dTheta - Math.PI) < 1e-3) {
    return null;
  }

  const cosDTheta = Math.cos(dTheta);
  const sinSign = dTheta < Math.PI ? 1 : -1;
  const A = sinSign * Math.sqrt(Math.max(0, r1 * r2 * (1 + cosDTheta)));
  if (Math.abs(A) < 1e-9) {
    return null;
  }

  // Elliptical single-revolution domain lies in z in (0, 4*pi^2)
  let zLo = 1e-6;
  if (evaluateLambertY(r1, r2, A, zLo) <= 0) {
    // Advance zLo until y(z) > 0 (happens for dTheta > pi near z = 0)
    let lo = 1e-6;
    let hi = 4 * Math.PI * Math.PI - 0.05;
    for (let i = 0; i < 24; i++) {
      const mid = 0.5 * (lo + hi);
      if (evaluateLambertY(r1, r2, A, mid) > 0) {
        hi = mid;
      } else {
        lo = mid;
      }
    }
    zLo = hi;
  }

  let zHi = 4 * Math.PI * Math.PI - 0.05;
  if (A < 0) {
    // For retrograde-sense chord (dTheta > pi), y(z) can drop <= 0 near 4*pi^2
    let probe = zHi;
    while (probe > zLo + 0.01 && evaluateLambertY(r1, r2, A, probe) <= 0) {
      probe -= 0.5;
    }
    if (evaluateLambertY(r1, r2, A, probe) <= 0) {
      return null;
    }
    zHi = probe;
  }

  const tofLo = evaluateLambertTof(r1, r2, A, zLo);
  const tofHi = evaluateLambertTof(r1, r2, A, zHi);
  if (tofLo === null || tofHi === null || dtSec < tofLo || dtSec > tofHi) {
    return null;
  }

  let lo = zLo;
  let hi = zHi;
  let z = 0.5 * (lo + hi);
  let y = evaluateLambertY(r1, r2, A, z);

  for (let i = 0; i < 28; i++) {
    z = 0.5 * (lo + hi);
    const tof = evaluateLambertTof(r1, r2, A, z);
    if (tof === null) {
      hi = z;
      continue;
    }
    const err = tof - dtSec;
    if (Math.abs(err) <= dtSec * 1e-7) {
      y = evaluateLambertY(r1, r2, A, z);
      break;
    }
    if (err < 0) {
      lo = z;
    } else {
      hi = z;
    }
    y = evaluateLambertY(r1, r2, A, z);
  }

  if (!(y > 0)) {
    return null;
  }

  const f = 1 - y / r1;
  const g = A * Math.sqrt(y / MU_SUN);
  const gDot = 1 - y / r2;
  if (Math.abs(g) < 1e-12) {
    return null;
  }

  const v1: Vec2 = {
    x: (r2Vec.x - f * r1Vec.x) / g,
    y: (r2Vec.y - f * r1Vec.y) / g,
  };
  const v2: Vec2 = {
    x: (gDot * r2Vec.x - r1Vec.x) / g,
    y: (gDot * r2Vec.y - r1Vec.y) / g,
  };

  // Validate prograde, bound elliptical, non-solar-impacting trajectory
  const h = r1Vec.x * v1.y - r1Vec.y * v1.x;
  if (h <= 1e-9) {
    return null;
  }

  const energy = getSpecificOrbitalEnergy(r1Vec, v1);
  if (energy >= -1e-9) {
    return null;
  }

  const ex = (v1.y * h) / MU_SUN - r1Vec.x / r1;
  const ey = -(v1.x * h) / MU_SUN - r1Vec.y / r1;
  const e = Math.hypot(ex, ey);
  if (!Number.isFinite(e) || e > MAX_TRANSFER_ECCENTRICITY) {
    return null;
  }

  const a = -MU_SUN / (2 * energy);
  const periapsis = a * (1 - e);
  if (periapsis <= MIN_SOLAR_PERIAPSIS_AU) {
    return null;
  }

  const orbit = stateToOrbit(r1Vec, v1, t0Sec);
  return { v1, v2, orbit };
}

function minBodyClearanceAu(
  p1: Vec2,
  p2: Vec2,
  bodyCenters: ReadonlyArray<{ pos: Vec2; radius: number }>,
): number {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-18) {
    return Number.POSITIVE_INFINITY;
  }

  let best = Number.POSITIVE_INFINITY;
  for (const body of bodyCenters) {
    if (body.radius <= 0) {
      continue;
    }
    const rawT = ((body.pos.x - p1.x) * dx + (body.pos.y - p1.y) * dy) / lenSq;
    const t = rawT < 0 ? 0 : rawT > 1 ? 1 : rawT;
    const cx = p1.x + t * dx - body.pos.x;
    const cy = p1.y + t * dy - body.pos.y;
    const clearance = Math.hypot(cx, cy) - body.radius;
    if (clearance < best) {
      best = clearance;
    }
  }
  return best;
}

/**
 * Finds departure timestamps in [nowSec, nowSec + horizonSec] where the unit's position is
 * occluded from all enemy observers by celestial bodies (including Sun and planets).
 * Uses coarse sampling plus golden-section closest-approach refinement so narrow 2-4s
 * occlusion cones are reliably captured.
 */
export function findOccludedDepartureTimes(
  unitOrbit: KeplerOrbit,
  nowSec: number,
  horizonSec: number,
  bodies: readonly CelestialBody[],
  resolveObserversAt: (tSec: number) => readonly Vec2[],
): number[] {
  const dtSample = 1.5;
  const steps = Math.max(8, Math.ceil(horizonSec / dtSample));
  const stepDt = horizonSec / steps;

  const isAllOccluded = (tSec: number): boolean => {
    const observers = resolveObserversAt(tSec);
    if (observers.length === 0) {
      return false;
    }
    const unitPos = orbitToState(unitOrbit, tSec).pos;
    for (const obs of observers) {
      if (!isOccluded(unitPos, obs, bodies, tSec)) {
        return false;
      }
    }
    return true;
  };

  const maxObserverClearance = (tSec: number): number => {
    const observers = resolveObserversAt(tSec);
    if (observers.length === 0) {
      return Number.POSITIVE_INFINITY;
    }
    const unitPos = orbitToState(unitOrbit, tSec).pos;
    const centers = bodies.map((b) => ({
      pos: getBodyStateAt(b, tSec).pos,
      radius: b.occlusionRadiusAu,
    }));
    let worst = Number.NEGATIVE_INFINITY;
    for (const obs of observers) {
      const c = minBodyClearanceAu(unitPos, obs, centers);
      if (c > worst) {
        worst = c;
      }
    }
    return worst;
  };

  const times: number[] = [];
  const clearances: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = nowSec + i * stepDt;
    times.push(t);
    clearances.push(maxObserverClearance(t));
  }

  const candidates: number[] = [];
  const pushUnique = (t: number) => {
    if (candidates.every((existing) => Math.abs(existing - t) > 0.4)) {
      candidates.push(t);
    }
  };

  for (let i = 0; i <= steps; i++) {
    const t = times[i]!;
    if (clearances[i]! < 0 && isAllOccluded(t)) {
      pushUnique(t);
    }

    // Refine local clearance dips (< 0.08 AU) via golden-section search to catch narrow cones
    if (
      i > 0 &&
      i < steps &&
      clearances[i]! < 0.08 &&
      clearances[i]! <= clearances[i - 1]! &&
      clearances[i]! <= clearances[i + 1]!
    ) {
      let a = times[i - 1]!;
      let b = times[i + 1]!;
      const phi = (Math.sqrt(5) - 1) * 0.5;
      let c = b - phi * (b - a);
      let d = a + phi * (b - a);
      let fc = maxObserverClearance(c);
      let fd = maxObserverClearance(d);
      for (let iter = 0; iter < 6; iter++) {
        if (fc < fd) {
          b = d;
          d = c;
          fd = fc;
          c = b - phi * (b - a);
          fc = maxObserverClearance(c);
        } else {
          a = c;
          c = d;
          fc = fd;
          d = a + phi * (b - a);
          fd = maxObserverClearance(d);
        }
      }
      const tStar = 0.5 * (a + b);
      if (isAllOccluded(tStar)) {
        // Also probe ±0.6s inside the cone in case midpoint sits near dTheta == pi
        for (const offset of [-0.6, 0, 0.6]) {
          const probe = Math.max(nowSec, Math.min(nowSec + horizonSec, tStar + offset));
          if (isAllOccluded(probe)) {
            pushUnique(probe);
          }
        }
      }
    }
  }

  candidates.sort((a, b) => a - b);
  return candidates;
}
