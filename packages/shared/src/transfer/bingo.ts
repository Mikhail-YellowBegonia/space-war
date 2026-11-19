import { BINGO_CONFIG, CELESTIAL_BODIES_BY_ID } from '../config/index.js';
import { MU_SUN, stateToOrbit, type OrbitalState } from '../physics/index.js';
import type { BingoWarningLevel, CelestialBody, FactionId, KeplerOrbit, Vec2 } from '../types/index.js';

export interface ResupplyPoint {
  id: string;
  pos?: Vec2;
  orbit?: KeplerOrbit;
}

export interface BingoEvaluation {
  bingoDeltaV: number;
  warning: BingoWarningLevel;
  nearestResupplyId?: string;
}

/**
 * Estimates the conservative minimum two-burn Hohmann delta-v (AU/s) required to move
 * from `fromOrbit` to a circular target orbit at `toRadiusAu`.
 */
export function estimateHohmannDeltaVBetweenOrbits(
  fromOrbit: KeplerOrbit,
  toRadiusAu: number,
): number {
  const r1 = Math.max(0.08, fromOrbit.a);
  const r2 = Math.max(0.08, toRadiusAu);

  if (Math.abs(r1 - r2) <= 1e-6) {
    // Minor circularization / phasing margin if eccentric
    const vCirc = Math.sqrt(MU_SUN / r1);
    return 0.5 * fromOrbit.e * vCirc;
  }

  const aTransfer = 0.5 * (r1 + r2);
  const v1 = Math.sqrt(MU_SUN / r1);
  const v2 = Math.sqrt(MU_SUN / r2);
  const vTransfer1 = Math.sqrt(MU_SUN * (2 / r1 - 1 / aTransfer));
  const vTransfer2 = Math.sqrt(MU_SUN * (2 / r2 - 1 / aTransfer));

  return Math.abs(vTransfer1 - v1) + Math.abs(v2 - vTransfer2);
}

function resolveSiteRadiusAu(site: ResupplyPoint): number | null {
  if (site.orbit && site.orbit.a > 0) {
    return site.orbit.a;
  }
  if (site.pos) {
    const r = Math.hypot(site.pos.x, site.pos.y);
    return r > 1e-6 ? r : null;
  }
  return null;
}

function isOrbitalState(value: OrbitalState | KeplerOrbit): value is OrbitalState {
  return 'pos' in value && 'vel' in value;
}

/**
 * Computes conservative Bingo return delta-v (with BINGO_CONFIG.safetyMultiplier = 1.15)
 * from an arrival orbital state/orbit back to the nearest friendly resupply point.
 */
export function calculateBingoDeltaV(
  arrivalStateOrOrbit: OrbitalState | KeplerOrbit,
  friendlyResupplySites?: readonly ResupplyPoint[],
  arrivalSec = 0,
  fallbackFaction?: FactionId,
  bodiesById: Readonly<Record<string, CelestialBody>> = CELESTIAL_BODIES_BY_ID,
): { bingoDeltaV: number; nearestResupplyId?: string } {
  const arrivalOrbit = isOrbitalState(arrivalStateOrOrbit)
    ? stateToOrbit(arrivalStateOrOrbit.pos, arrivalStateOrOrbit.vel, arrivalSec)
    : arrivalStateOrOrbit;

  let sites = friendlyResupplySites ? [...friendlyResupplySites] : [];
  if (sites.length === 0 && fallbackFaction) {
    const homeBody = bodiesById[fallbackFaction];
    if (homeBody?.orbit) {
      sites = [{ id: homeBody.id, orbit: homeBody.orbit }];
    }
  }

  if (sites.length === 0) {
    return { bingoDeltaV: 0 };
  }

  let bestRawDv = Number.POSITIVE_INFINITY;
  let nearestId: string | undefined;

  for (const site of sites) {
    const targetRadius = resolveSiteRadiusAu(site);
    if (targetRadius === null) {
      continue;
    }
    const dv = estimateHohmannDeltaVBetweenOrbits(arrivalOrbit, targetRadius);
    if (dv < bestRawDv) {
      bestRawDv = dv;
      nearestId = site.id;
    }
  }

  if (!Number.isFinite(bestRawDv)) {
    return { bingoDeltaV: 0 };
  }

  return {
    bingoDeltaV: bestRawDv * BINGO_CONFIG.safetyMultiplier,
    nearestResupplyId: nearestId,
  };
}

/**
 * Classifies post-transfer remaining delta-v against the Bingo threshold:
 * - 'red': remainingAfter < bingoDeltaV (one-way trip risk)
 * - 'amber': remainingAfter < bingoDeltaV * 1.2 (approaching return margin)
 * - 'safe': sufficient return margin
 */
export function classifyBingoWarning(
  remainingDeltaV: number,
  transferCostDeltaV: number,
  bingoDeltaV: number,
): BingoWarningLevel {
  const remainingAfter = remainingDeltaV - transferCostDeltaV;
  if (remainingAfter < bingoDeltaV - 1e-12) {
    return 'red';
  }
  if (remainingAfter < bingoDeltaV * BINGO_CONFIG.amberThresholdMultiplier - 1e-12) {
    return 'amber';
  }
  return 'safe';
}

/**
 * Evaluates both Bingo return delta-v and warning level in one call.
 */
export function evaluateBingo(
  arrivalStateOrOrbit: OrbitalState | KeplerOrbit,
  remainingDeltaV: number,
  transferCostDeltaV: number,
  friendlyResupplySites?: readonly ResupplyPoint[],
  arrivalSec = 0,
  fallbackFaction?: FactionId,
): BingoEvaluation {
  const { bingoDeltaV, nearestResupplyId } = calculateBingoDeltaV(
    arrivalStateOrOrbit,
    friendlyResupplySites,
    arrivalSec,
    fallbackFaction,
  );
  return {
    bingoDeltaV,
    warning: classifyBingoWarning(remainingDeltaV, transferCostDeltaV, bingoDeltaV),
    nearestResupplyId,
  };
}
