import {
  CELESTIAL_BODIES_BY_ID,
  PROPULSION_CONFIGS,
  SOLAR_SYSTEM_BODIES,
} from '../config/index.js';
import {
  getBodyStateAt,
  getEffectiveMaxAccelAuPerSec2,
  getOrbitalPeriodSec,
  isOccluded,
  MU_SUN,
  normalizeAngle,
  orbitToState,
  stateToOrbit,
  stepContinuousThrust,
} from '../physics/index.js';
import type {
  CelestialBody,
  FactionId,
  KeplerOrbit,
  PropulsionType,
  SensorTrack,
  SubsystemHealth,
  TransferBurn,
  TransferMode,
  TransferOption,
  UnitEntity,
  UnitSubsystems,
  Vec2,
} from '../types/index.js';
import { evaluateBingo, type ResupplyPoint } from './bingo.js';
import { findOccludedDepartureTimes, solveLambertTransfer } from './lambert.js';

export interface TransferSolverContext {
  unit: Pick<UnitEntity, 'pos' | 'vel' | 'orbit' | 'propulsion' | 'deltaV' | 'faction'> & {
    subsystems?: Partial<UnitSubsystems>;
  };
  nowSec: number;
  celestialBodies?: readonly CelestialBody[];
  /** Static enemy observer positions; if omitted, uses enemy home planet position at tSec. */
  observerPositions?: readonly Vec2[];
  /** Optional dynamic enemy observer resolver evaluated at departure candidate timestamp. */
  resolveObserverPositionsAt?: (tSec: number) => readonly Vec2[];
  /** Friendly resupply points used for Bingo delta-v evaluation. */
  friendlyResupplySites?: readonly ResupplyPoint[];
}

export type InterceptTarget =
  | string
  | CelestialBody
  | KeplerOrbit
  | { orbit: KeplerOrbit }
  | Pick<SensorTrack, 'estimatedOrbit' | 'pos' | 'vel'>;

interface EvaluatedTransfer {
  option: TransferOption;
  rawDeltaV: number;
}

function getEnemyFaction(faction: FactionId): FactionId {
  return faction === 'earth' ? 'mars' : 'earth';
}

function createObserverResolver(
  ctx: TransferSolverContext,
  bodies: readonly CelestialBody[],
): (tSec: number) => readonly Vec2[] {
  if (ctx.resolveObserverPositionsAt) {
    return ctx.resolveObserverPositionsAt;
  }
  if (ctx.observerPositions && ctx.observerPositions.length > 0) {
    const fixed = ctx.observerPositions;
    return () => fixed;
  }
  const enemyFaction = getEnemyFaction(ctx.unit.faction);
  const enemyHome =
    bodies.find((b) => b.ownerSlot === enemyFaction || b.id === enemyFaction) ??
    CELESTIAL_BODIES_BY_ID[enemyFaction];

  if (!enemyHome) {
    return () => [];
  }
  return (tSec: number) => [getBodyStateAt(enemyHome, tSec).pos];
}

function computeHohmannFlightTimeSec(a1: number, a2: number): number {
  const aTransfer = 0.5 * (Math.max(0.08, a1) + Math.max(0.08, a2));
  return Math.PI * Math.sqrt((aTransfer * aTransfer * aTransfer) / MU_SUN);
}

function computeSynodicSearchHorizonSec(a1: number, a2: number): number {
  const t1 = getOrbitalPeriodSec(Math.max(0.08, a1));
  const t2 = getOrbitalPeriodSec(Math.max(0.08, a2));
  const n1 = (2 * Math.PI) / t1;
  const n2 = (2 * Math.PI) / t2;
  const dn = Math.abs(n1 - n2);
  if (dn < 1e-4) {
    return Math.min(600, Math.max(t1, t2));
  }
  const synodic = (2 * Math.PI) / dn;
  return Math.min(600, Math.max(t1, 1.5 * synodic));
}

function computePeakIrRisk(
  propulsion: PropulsionType,
  burns: readonly TransferBurn[],
  throttled: boolean,
): number {
  const allOccluded = burns.length > 0 && burns.every((b) => b.isOccludedStart);
  const firstOccluded = burns.length > 0 && burns[0]!.isOccludedStart;

  switch (propulsion) {
    case 'electric':
      return 0.08;
    case 'chemical':
      if (allOccluded) return 0.16;
      if (firstOccluded) return 0.22;
      return throttled ? 0.3 : 0.62;
    case 'nuclear':
      if (allOccluded) return 0.14;
      if (firstOccluded) return 0.24;
      return 0.96;
  }
}

function makeInfeasibleOption(
  mode: TransferMode,
  reason: string,
  ctx: TransferSolverContext,
  fallbackCost = 0,
  fallbackArrival?: number,
  burns: TransferBurn[] = [],
  previewOrbitSegments: KeplerOrbit[] = [],
  arrivalOrbit?: KeplerOrbit,
): TransferOption {
  const arrivalSec = fallbackArrival ?? ctx.nowSec;
  const bingo = evaluateBingo(
    arrivalOrbit ?? ctx.unit.orbit,
    ctx.unit.deltaV,
    fallbackCost,
    ctx.friendlyResupplySites,
    arrivalSec,
    ctx.unit.faction,
  );
  return {
    mode,
    feasible: false,
    reason,
    burns,
    previewOrbitSegments,
    arrivalSec,
    totalDeltaV: fallbackCost,
    estimatedPeakIr: burns.length > 0 ? computePeakIrRisk(ctx.unit.propulsion, burns, false) : 0,
    bingoDeltaV: bingo.bingoDeltaV,
    bingoWarning: bingo.warning,
  };
}

function buildOptionFromCandidate(
  mode: TransferMode,
  ctx: TransferSolverContext,
  t0: number,
  dt: number,
  dv1: Vec2,
  dv2: Vec2,
  transferOrbit: KeplerOrbit,
  arrivalOrbit: KeplerOrbit,
  options: {
    occludedDep?: boolean;
    occludedArr?: boolean;
    throttled?: boolean;
  } = {},
): EvaluatedTransfer {
  const propHealth: SubsystemHealth = ctx.unit.subsystems?.propulsion ?? 'normal';
  const maxAccel = getEffectiveMaxAccelAuPerSec2(ctx.unit.propulsion, propHealth);
  const dv1Mag = Math.hypot(dv1.x, dv1.y);
  const dv2Mag = Math.hypot(dv2.x, dv2.y);
  const totalDeltaV = dv1Mag + dv2Mag;
  const arrivalSec = t0 + dt;

  const durationForBurn = (dvMag: number): number => {
    if (options.throttled) {
      return Math.max(25, dvMag / Math.max(1e-6, maxAccel * 0.25));
    }
    if (PROPULSION_CONFIGS[ctx.unit.propulsion].burnMode === 'continuous') {
      return Math.max(1, dvMag / Math.max(1e-6, maxAccel));
    }
    return 0.1;
  };

  const burns: TransferBurn[] = [
    {
      executeAtSec: t0,
      deltaV: dv1,
      durationSec: durationForBurn(dv1Mag),
      isOccludedStart: options.occludedDep ?? false,
    },
  ];
  if (dv2Mag > 1e-7) {
    burns.push({
      executeAtSec: arrivalSec,
      deltaV: dv2,
      durationSec: durationForBurn(dv2Mag),
      isOccludedStart: options.occludedArr ?? false,
    });
  }

  const bingo = evaluateBingo(
    arrivalOrbit,
    ctx.unit.deltaV,
    totalDeltaV,
    ctx.friendlyResupplySites,
    arrivalSec,
    ctx.unit.faction,
  );

  const canAfford = propHealth !== 'offline' && totalDeltaV <= ctx.unit.deltaV + 1e-12;
  const reason =
    propHealth === 'offline'
      ? 'Propulsion subsystem offline'
      : totalDeltaV > ctx.unit.deltaV + 1e-12
        ? 'Insufficient delta-v'
        : undefined;

  return {
    rawDeltaV: totalDeltaV,
    option: {
      mode,
      feasible: canAfford,
      ...(reason ? { reason } : {}),
      burns,
      previewOrbitSegments: [transferOrbit, arrivalOrbit],
      arrivalSec,
      totalDeltaV,
      estimatedPeakIr: computePeakIrRisk(ctx.unit.propulsion, burns, options.throttled ?? false),
      bingoDeltaV: bingo.bingoDeltaV,
      bingoWarning: bingo.warning,
    },
  };
}

function solveElectricSpiralTransfer(
  mode: TransferMode,
  ctx: TransferSolverContext,
  targetSemiMajorAxisAu: number,
  targetOrbitPreview: KeplerOrbit,
): TransferOption {
  const propHealth: SubsystemHealth = ctx.unit.subsystems?.propulsion ?? 'normal';
  const maxAccel = getEffectiveMaxAccelAuPerSec2('electric', propHealth);
  if (propHealth === 'offline' || maxAccel <= 0) {
    return makeInfeasibleOption(mode, 'Propulsion subsystem offline', ctx);
  }

  const r1 = ctx.unit.orbit.a;
  const r2 = Math.max(0.08, targetSemiMajorAxisAu);
  const v1 = Math.sqrt(MU_SUN / r1);
  const v2 = Math.sqrt(MU_SUN / r2);
  const estimatedSpiralDv = Math.max(1e-5, Math.abs(v1 - v2) * 1.05 + Math.abs(ctx.unit.orbit.e - targetOrbitPreview.e) * v1 * 0.25);

  const steps = 40;
  const totalDuration = Math.max(8, estimatedSpiralDv / maxAccel);
  const dtStep = totalDuration / steps;
  const progradeSign = r2 >= r1 ? 1 : -1;

  let curState = orbitToState(ctx.unit.orbit, ctx.nowSec);
  let curTime = ctx.nowSec;
  let totalUsed = 0;

  const burns: TransferBurn[] = [];
  const previewSegments: KeplerOrbit[] = [];
  const chunkSize = 10;
  let chunkStart = curTime;
  let chunkDvX = 0;
  let chunkDvY = 0;

  for (let i = 0; i < steps; i++) {
    const vMag = Math.hypot(curState.vel.x, curState.vel.y);
    const dirX = vMag > 1e-12 ? (curState.vel.x / vMag) * progradeSign : 0;
    const dirY = vMag > 1e-12 ? (curState.vel.y / vMag) * progradeSign : 1;
    const stepDvMag = (estimatedSpiralDv / steps);
    const desiredDv: Vec2 = { x: dirX * stepDvMag, y: dirY * stepDvMag };

    const res = stepContinuousThrust(
      curState,
      desiredDv,
      dtStep,
      Math.max(ctx.unit.deltaV - totalUsed, estimatedSpiralDv),
      'electric',
      curTime,
      { subSteps: 1, propulsionHealth: propHealth },
    );

    curState = res.state;
    curTime += dtStep;
    totalUsed += res.usedDeltaV;
    chunkDvX += res.appliedDeltaV.x;
    chunkDvY += res.appliedDeltaV.y;

    if ((i + 1) % chunkSize === 0 || i === steps - 1) {
      burns.push({
        executeAtSec: chunkStart,
        deltaV: { x: chunkDvX, y: chunkDvY },
        durationSec: curTime - chunkStart,
        isOccludedStart: false,
      });
      previewSegments.push(res.orbit);
      chunkStart = curTime;
      chunkDvX = 0;
      chunkDvY = 0;
    }
  }

  previewSegments.push(targetOrbitPreview);
  const arrivalSec = curTime;
  const finalOrbit = stateToOrbit(curState.pos, curState.vel, arrivalSec);
  const bingo = evaluateBingo(
    finalOrbit,
    ctx.unit.deltaV,
    totalUsed,
    ctx.friendlyResupplySites,
    arrivalSec,
    ctx.unit.faction,
  );
  const feasible = totalUsed <= ctx.unit.deltaV + 1e-12;

  return {
    mode,
    feasible,
    ...(feasible ? {} : { reason: 'Insufficient delta-v' }),
    burns,
    previewOrbitSegments: previewSegments,
    arrivalSec,
    totalDeltaV: totalUsed,
    estimatedPeakIr: 0.08,
    bingoDeltaV: bingo.bingoDeltaV,
    bingoWarning: bingo.warning,
  };
}

function resolveInterceptOrbit(
  target: InterceptTarget,
  nowSec: number,
  bodies: readonly CelestialBody[],
): { orbit: KeplerOrbit; name: string } | null {
  if (typeof target === 'string') {
    const body =
      bodies.find((b) => b.id === target) ?? CELESTIAL_BODIES_BY_ID[target];
    if (!body?.orbit) {
      return null;
    }
    return { orbit: body.orbit, name: body.id };
  }

  if ('occlusionRadiusAu' in target) {
    if (!target.orbit) {
      return null;
    }
    return { orbit: target.orbit, name: target.id };
  }

  if ('a' in target && 'e' in target) {
    return { orbit: target, name: 'orbit' };
  }

  if ('orbit' in target && target.orbit) {
    return { orbit: target.orbit, name: 'unit' };
  }

  if ('estimatedOrbit' in target && target.estimatedOrbit) {
    return { orbit: target.estimatedOrbit, name: 'track' };
  }

  if ('pos' in target && target.pos) {
    if (target.vel) {
      return { orbit: stateToOrbit(target.pos, target.vel, nowSec), name: 'track-state' };
    }
    const r = Math.hypot(target.pos.x, target.pos.y);
    if (r <= 1e-6) {
      return null;
    }
    return {
      orbit: {
        a: r,
        e: 0,
        omega: 0,
        meanAnomaly0: normalizeAngle(Math.atan2(target.pos.y, target.pos.x)),
        epochSec: nowSec,
      },
      name: 'track-pos',
    };
  }

  return null;
}

/**
 * Solves for all three transfer strategies (`fuel`, `fast`, `stealth`) to rendezvous with /
 * intercept a moving target (celestial body ID, unit, KeplerOrbit, or SensorTrack).
 */
export function solveInterceptTransfer(
  ctx: TransferSolverContext,
  target: InterceptTarget,
): Record<TransferMode, TransferOption> {
  const bodies = ctx.celestialBodies ?? SOLAR_SYSTEM_BODIES;
  const resolved = resolveInterceptOrbit(target, ctx.nowSec, bodies);
  if (!resolved) {
    return {
      fuel: makeInfeasibleOption('fuel', 'Target orbit unavailable for intercept', ctx),
      fast: makeInfeasibleOption('fast', 'Target orbit unavailable for intercept', ctx),
      stealth: makeInfeasibleOption('stealth', 'Target orbit unavailable for intercept', ctx),
    };
  }

  const targetOrbit = resolved.orbit;
  const dtH = computeHohmannFlightTimeSec(ctx.unit.orbit.a, targetOrbit.a);
  const horizonSec = computeSynodicSearchHorizonSec(ctx.unit.orbit.a, targetOrbit.a);
  const observerResolver = createObserverResolver(ctx, bodies);

  const evaluatePair = (
    mode: TransferMode,
    t0: number,
    dt: number,
    extra: { occludedDep?: boolean; occludedArr?: boolean; throttled?: boolean } = {},
    precomputedDepState = orbitToState(ctx.unit.orbit, t0),
  ): EvaluatedTransfer | null => {
    const arrState = orbitToState(targetOrbit, t0 + dt);
    const lambert = solveLambertTransfer(precomputedDepState.pos, arrState.pos, dt, t0);
    if (!lambert) {
      return null;
    }
    const dv1 = {
      x: lambert.v1.x - precomputedDepState.vel.x,
      y: lambert.v1.y - precomputedDepState.vel.y,
    };
    const dv2 = { x: arrState.vel.x - lambert.v2.x, y: arrState.vel.y - lambert.v2.y };
    return buildOptionFromCandidate(
      mode,
      ctx,
      t0,
      dt,
      dv1,
      dv2,
      lambert.orbit,
      targetOrbit,
      extra,
    );
  };

  // 1. FUEL-OPTIMAL: scan synodic horizon, then pick the nearest Hohmann window within 3.5% of global min
  const t0Count = 24;
  const dtFactors = [0.7, 0.85, 0.95, 1.04, 1.15, 1.25];
  const perT0Best: Array<{ cand: EvaluatedTransfer; t0: number; dt: number }> = [];
  let globalMinDv = Number.POSITIVE_INFINITY;

  for (let i = 0; i <= t0Count; i++) {
    const t0 = ctx.nowSec + (horizonSec * i) / t0Count;
    const depState = orbitToState(ctx.unit.orbit, t0);
    let bestAtT0: { cand: EvaluatedTransfer; t0: number; dt: number } | null = null;
    for (const f of dtFactors) {
      const dt = dtH * f;
      const cand = evaluatePair('fuel', t0, dt, {}, depState);
      if (cand && (!bestAtT0 || cand.rawDeltaV < bestAtT0.cand.rawDeltaV)) {
        bestAtT0 = { cand, t0, dt };
      }
    }
    if (bestAtT0) {
      perT0Best.push(bestAtT0);
      if (bestAtT0.cand.rawDeltaV < globalMinDv) {
        globalMinDv = bestAtT0.cand.rawDeltaV;
      }
    }
  }

  let bestFuel: EvaluatedTransfer | null = null;
  let bestT0 = ctx.nowSec;
  let bestDt = dtH;
  const nearGlobalThreshold = globalMinDv * 1.035;
  for (const entry of perT0Best) {
    if (entry.cand.rawDeltaV <= nearGlobalThreshold) {
      bestFuel = entry.cand;
      bestT0 = entry.t0;
      bestDt = entry.dt;
      break;
    }
  }

  // Coordinate refinement around the nearest near-optimal Hohmann window
  if (bestFuel) {
    let stepT0 = horizonSec / t0Count / 2;
    let stepDt = dtH * 0.08;
    for (let iter = 0; iter < 3; iter++) {
      for (const dt0 of [-stepT0, 0, stepT0]) {
        const candT0 = Math.max(ctx.nowSec, bestT0 + dt0);
        for (const ddt of [-stepDt, 0, stepDt]) {
          const candDt = Math.max(dtH * 0.4, bestDt + ddt);
          const cand = evaluatePair('fuel', candT0, candDt);
          if (cand && cand.rawDeltaV < bestFuel.rawDeltaV) {
            bestFuel = cand;
            bestT0 = candT0;
            bestDt = candDt;
          }
        }
      }
      stepT0 *= 0.5;
      stepDt *= 0.5;
    }
  }

  const fuelOption =
    bestFuel?.option ?? makeInfeasibleOption('fuel', 'No valid transfer trajectory found', ctx);

  // 2. FAST: earliest arrival within available delta-v budget (and earlier than fuel)
  let bestFast: EvaluatedTransfer | null = null;
  let bestFastFallback: EvaluatedTransfer | null = null;
  const fastT0Offsets = [0, 4, 10];
  const fastDtFactors = [
    0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.92,
  ];

  for (const offset of fastT0Offsets) {
    const t0 = ctx.nowSec + offset;
    const depState = orbitToState(ctx.unit.orbit, t0);
    for (const f of fastDtFactors) {
      const dt = dtH * f;
      const cand = evaluatePair('fast', t0, dt, {}, depState);
      if (!cand) {
        continue;
      }
      if (!bestFastFallback || cand.option.arrivalSec < bestFastFallback.option.arrivalSec) {
        bestFastFallback = cand;
      }
      if (cand.option.feasible) {
        if (!bestFast || cand.option.arrivalSec < bestFast.option.arrivalSec) {
          bestFast = cand;
        }
      }
    }
  }

  const fastOption = bestFast
    ? bestFast.option
    : bestFastFallback
      ? makeInfeasibleOption(
          'fast',
          bestFastFallback.option.reason ?? 'Insufficient delta-v for fast intercept',
          ctx,
          bestFastFallback.rawDeltaV,
          bestFastFallback.option.arrivalSec,
          bestFastFallback.option.burns,
          bestFastFallback.option.previewOrbitSegments,
          targetOrbit,
        )
      : makeInfeasibleOption('fast', 'No valid fast intercept found', ctx);

  // 3. STEALTH: propulsion-dependent strategy
  let stealthOption: TransferOption;
  if (ctx.unit.propulsion === 'electric') {
    stealthOption = solveElectricSpiralTransfer('stealth', ctx, targetOrbit.a, targetOrbit);
  } else {
    const searchWindow = Math.max(getOrbitalPeriodSec(ctx.unit.orbit.a) * 1.25, 320);
    const occludedTimes = findOccludedDepartureTimes(
      ctx.unit.orbit,
      ctx.nowSec,
      searchWindow,
      bodies,
      observerResolver,
    );

    let bestOccludedWin: { cand: EvaluatedTransfer; t0: number; dt: number; depState: ReturnType<typeof orbitToState> } | null = null;
    const stealthDtFactors = [0.6, 0.75, 0.9, 1.0, 1.12, 1.25];
    for (const t0 of occludedTimes.slice(0, 16)) {
      const depState = orbitToState(ctx.unit.orbit, t0);
      for (const f of stealthDtFactors) {
        const dt = dtH * f;
        const cand = evaluatePair(
          'stealth',
          t0,
          dt,
          { occludedDep: true, occludedArr: false },
          depState,
        );
        if (cand && (!bestOccludedWin || cand.rawDeltaV < bestOccludedWin.cand.rawDeltaV)) {
          bestOccludedWin = { cand, t0, dt, depState };
        }
      }
    }

    let bestOccluded: EvaluatedTransfer | null = bestOccludedWin?.cand ?? null;
    if (bestOccludedWin) {
      const arrTime = bestOccludedWin.t0 + bestOccludedWin.dt;
      const arrObservers = observerResolver(arrTime);
      const arrPos = orbitToState(targetOrbit, arrTime).pos;
      const arrOccluded =
        arrObservers.length > 0 &&
        arrObservers.every((obs) => isOccluded(arrPos, obs, bodies, arrTime));
      if (arrOccluded) {
        bestOccluded = evaluatePair(
          'stealth',
          bestOccludedWin.t0,
          bestOccludedWin.dt,
          { occludedDep: true, occludedArr: true },
          bestOccludedWin.depState,
        );
      }
    }

    if (ctx.unit.propulsion === 'nuclear') {
      stealthOption =
        bestOccluded?.option ??
        makeInfeasibleOption('stealth', 'No celestial occlusion window for nuclear stealth burn', ctx);
    } else {
      // Chemical dual-mode: prefer feasible occluded pulse; else throttled slow burn
      if (bestOccluded && bestOccluded.option.feasible) {
        stealthOption = bestOccluded.option;
      } else if (bestFuel) {
        const throttled = evaluatePair('stealth', bestT0, bestDt, { throttled: true });
        stealthOption =
          throttled?.option ??
          makeInfeasibleOption('stealth', 'No stealth chemical transfer found', ctx);
      } else {
        stealthOption = makeInfeasibleOption('stealth', 'No stealth chemical transfer found', ctx);
      }
    }
  }

  return {
    fuel: fuelOption,
    fast: fastOption,
    stealth: stealthOption,
  };
}

/**
 * Convenience helper returning intercept options in UI card order: `[fuel, fast, stealth]`.
 */
export function getInterceptTransferOptions(
  ctx: TransferSolverContext,
  target: InterceptTarget,
): [TransferOption, TransferOption, TransferOption] {
  const map = solveInterceptTransfer(ctx, target);
  return [map.fuel, map.fast, map.stealth];
}

interface RawInsertionCandidate {
  t0: number;
  dt: number;
  arrTime: number;
  dv1: Vec2;
  dv2: Vec2;
  rawDeltaV: number;
  transferOrbit: KeplerOrbit;
  sampleMeanAnomaly0: number;
}

function solveInsertionCandidates(
  mode: TransferMode,
  ctx: TransferSolverContext,
  targetOrbit: KeplerOrbit,
  departureTimes: readonly number[],
  dtFactors: readonly number[],
  options: { occludedDep?: boolean; throttled?: boolean; prioritizeEarliest?: boolean } = {},
): EvaluatedTransfer | null {
  const dtH = computeHohmannFlightTimeSec(ctx.unit.orbit.a, targetOrbit.a);
  const periodTarget = getOrbitalPeriodSec(targetOrbit.a);
  const targetSampleCount = 8;
  const propOffline = (ctx.unit.subsystems?.propulsion ?? 'normal') === 'offline';

  let best: RawInsertionCandidate | null = null;
  let bestFallback: RawInsertionCandidate | null = null;

  for (const t0 of departureTimes) {
    const depState = orbitToState(ctx.unit.orbit, t0);

    for (let j = 0; j < targetSampleCount; j++) {
      const sampleMeanAnomaly0 = (2 * Math.PI * j) / targetSampleCount;
      const targetSampleOrbit: KeplerOrbit = {
        a: targetOrbit.a,
        e: targetOrbit.e,
        omega: targetOrbit.omega,
        meanAnomaly0: sampleMeanAnomaly0,
        epochSec: 0,
      };

      for (const f of dtFactors) {
        const dt = Math.max(4, dtH * f);
        const arrTime = t0 + dt;
        const arrState = orbitToState(targetSampleOrbit, arrTime);

        const lambert = solveLambertTransfer(depState.pos, arrState.pos, dt, t0);
        if (!lambert) {
          continue;
        }
        const dv1X = lambert.v1.x - depState.vel.x;
        const dv1Y = lambert.v1.y - depState.vel.y;
        const dv2X = arrState.vel.x - lambert.v2.x;
        const dv2Y = arrState.vel.y - lambert.v2.y;
        const rawDeltaV = Math.hypot(dv1X, dv1Y) + Math.hypot(dv2X, dv2Y);

        if (options.prioritizeEarliest) {
          if (
            !bestFallback ||
            arrTime < bestFallback.arrTime ||
            (Math.abs(arrTime - bestFallback.arrTime) < 1e-6 && rawDeltaV < bestFallback.rawDeltaV)
          ) {
            bestFallback = {
              t0,
              dt,
              arrTime,
              dv1: { x: dv1X, y: dv1Y },
              dv2: { x: dv2X, y: dv2Y },
              rawDeltaV,
              transferOrbit: lambert.orbit,
              sampleMeanAnomaly0,
            };
          }
          const feasible = !propOffline && rawDeltaV <= ctx.unit.deltaV + 1e-12;
          if (
            feasible &&
            (!best ||
              arrTime < best.arrTime ||
              (Math.abs(arrTime - best.arrTime) < 1e-6 && rawDeltaV < best.rawDeltaV))
          ) {
            best = {
              t0,
              dt,
              arrTime,
              dv1: { x: dv1X, y: dv1Y },
              dv2: { x: dv2X, y: dv2Y },
              rawDeltaV,
              transferOrbit: lambert.orbit,
              sampleMeanAnomaly0,
            };
          }
        } else if (!best || rawDeltaV < best.rawDeltaV) {
          best = {
            t0,
            dt,
            arrTime,
            dv1: { x: dv1X, y: dv1Y },
            dv2: { x: dv2X, y: dv2Y },
            rawDeltaV,
            transferOrbit: lambert.orbit,
            sampleMeanAnomaly0,
          };
        }
      }
    }
  }

  const chosen = best ?? bestFallback;
  if (!chosen) {
    return null;
  }

  const insertedOrbit: KeplerOrbit = {
    a: targetOrbit.a,
    e: targetOrbit.e,
    omega: targetOrbit.omega,
    meanAnomaly0: normalizeAngle(
      chosen.sampleMeanAnomaly0 + ((2 * Math.PI) / periodTarget) * chosen.arrTime,
    ),
    epochSec: chosen.arrTime,
  };

  return buildOptionFromCandidate(
    mode,
    ctx,
    chosen.t0,
    chosen.dt,
    chosen.dv1,
    chosen.dv2,
    chosen.transferOrbit,
    insertedOrbit,
    options,
  );
}

/**
 * Solves for all three transfer strategies (`fuel`, `fast`, `stealth`) to insert the unit into
 * a desired target orbital ellipse (patrol, ambush, relay deployment, or escape corridor).
 */
export function solveOrbitInsertion(
  ctx: TransferSolverContext,
  targetOrbit: KeplerOrbit,
): Record<TransferMode, TransferOption> {
  const bodies = ctx.celestialBodies ?? SOLAR_SYSTEM_BODIES;
  const observerResolver = createObserverResolver(ctx, bodies);
  const period1 = getOrbitalPeriodSec(ctx.unit.orbit.a);

  // Near-identical orbit fast path
  const da = Math.abs(ctx.unit.orbit.a - targetOrbit.a);
  const de = Math.abs(ctx.unit.orbit.e - targetOrbit.e);
  if (da < 1e-4 && de < 1e-3 && (targetOrbit.e < 1e-3 || Math.abs(ctx.unit.orbit.omega - targetOrbit.omega) < 1e-2)) {
    const immediate = buildOptionFromCandidate(
      'fuel',
      ctx,
      ctx.nowSec,
      1,
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      ctx.unit.orbit,
      targetOrbit,
    ).option;
    return {
      fuel: { ...immediate, mode: 'fuel' },
      fast: { ...immediate, mode: 'fast' },
      stealth: { ...immediate, mode: 'stealth' },
    };
  }

  // 1. FUEL-OPTIMAL
  const fuelDepTimes: number[] = [];
  for (let i = 0; i < 6; i++) {
    fuelDepTimes.push(ctx.nowSec + (period1 * i) / 6);
  }
  const bestFuel = solveInsertionCandidates(
    'fuel',
    ctx,
    targetOrbit,
    fuelDepTimes,
    [0.75, 0.95, 1.05, 1.2],
  );
  const fuelOption =
    bestFuel?.option ?? makeInfeasibleOption('fuel', 'No valid insertion trajectory found', ctx);

  // 2. FAST
  const bestFast = solveInsertionCandidates(
    'fast',
    ctx,
    targetOrbit,
    [ctx.nowSec, ctx.nowSec + 4],
    [0.35, 0.45, 0.55, 0.65, 0.78, 0.9],
    { prioritizeEarliest: true },
  );
  const fastOption =
    bestFast?.option ?? makeInfeasibleOption('fast', 'No valid fast insertion found', ctx);

  // 3. STEALTH
  let stealthOption: TransferOption;
  if (ctx.unit.propulsion === 'electric') {
    stealthOption = solveElectricSpiralTransfer('stealth', ctx, targetOrbit.a, targetOrbit);
  } else {
    const occludedTimes = findOccludedDepartureTimes(
      ctx.unit.orbit,
      ctx.nowSec,
      Math.max(period1 * 1.25, 320),
      bodies,
      observerResolver,
    );
    const bestOccluded =
      occludedTimes.length > 0
        ? solveInsertionCandidates(
            'stealth',
            ctx,
            targetOrbit,
            occludedTimes.slice(0, 8),
            [0.75, 0.95, 1.15],
            { occludedDep: true },
          )
        : null;

    if (ctx.unit.propulsion === 'nuclear') {
      stealthOption =
        bestOccluded?.option ??
        makeInfeasibleOption('stealth', 'No celestial occlusion window for nuclear stealth burn', ctx);
    } else if (bestOccluded && bestOccluded.option.feasible) {
      stealthOption = bestOccluded.option;
    } else if (bestFuel) {
      const throttled = solveInsertionCandidates(
        'stealth',
        ctx,
        targetOrbit,
        [bestFuel.option.burns[0]?.executeAtSec ?? ctx.nowSec],
        [0.9, 1.0, 1.1],
        { throttled: true },
      );
      stealthOption =
        throttled?.option ??
        makeInfeasibleOption('stealth', 'No stealth chemical insertion found', ctx);
    } else {
      stealthOption = makeInfeasibleOption('stealth', 'No stealth chemical insertion found', ctx);
    }
  }

  return {
    fuel: fuelOption,
    fast: fastOption,
    stealth: stealthOption,
  };
}

/**
 * Convenience helper returning orbit insertion options in UI card order: `[fuel, fast, stealth]`.
 */
export function getOrbitInsertionOptions(
  ctx: TransferSolverContext,
  targetOrbit: KeplerOrbit,
): [TransferOption, TransferOption, TransferOption] {
  const map = solveOrbitInsertion(ctx, targetOrbit);
  return [map.fuel, map.fast, map.stealth];
}
