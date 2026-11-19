import {
  MUNITION_CONFIGS,
  UNIT_CONFIGS,
  applyImpulsiveBurn,
  isOccluded,
  orbitToState,
  solveLambertTransfer,
  stateToOrbit,
  type FactionId,
  type MunitionEntity,
  type MunitionProfileId,
  type SubsystemHealth,
  type UnitEntity,
  type Vec2,
} from '@space-war/shared';
import type { CommandValidationResult } from '../engine/commandPipeline.js';
import type { TickSystemHook } from '../engine/simulationLoop.js';
import type { MunitionRuntimeMeta, WorldState } from '../engine/worldState.js';
import { SENSOR_CONSTANTS, resolveTrackTargetForFiring } from './sensors.js';

export const MUNITION_CONSTANTS = {
  maxSalvoCount: 12,
  maxFlightSec: 240,
  coldCoastMinSec: 0.8,
  defaultBoostFractionCold: 0.65,
  defaultBoostFractionHot: 0.72,
  kineticAntiMissileMultiplier: 1.5,
  decoyRcsBias: 1.35,
  decoyIrBias: 1.25,
} as const;

export type CiwsInterceptHook = (
  world: WorldState,
  munition: MunitionEntity,
  targetUnit: UnitEntity,
) => boolean;

export type WarheadImpactHook = (
  world: WorldState,
  targetUnit: UnitEntity,
  damage: number,
  munition: MunitionEntity,
) => void;

export interface MunitionSystemHooks {
  ciwsIntercept?: CiwsInterceptHook;
  warheadImpact?: WarheadImpactHook;
}

export function getWeaponSubsystemFactor(health: SubsystemHealth): number {
  switch (health) {
    case 'normal':
      return 1.0;
    case 'damaged':
      return 0.5;
    case 'offline':
      return 0;
  }
}

function segmentClosestApproach(
  m0: Vec2,
  m1: Vec2,
  t0: Vec2,
  t1: Vec2,
): { dist: number; point: Vec2 } {
  const rx0 = m0.x - t0.x;
  const ry0 = m0.y - t0.y;
  const dvx = (m1.x - m0.x) - (t1.x - t0.x);
  const dvy = (m1.y - m0.y) - (t1.y - t0.y);
  const lenSq = dvx * dvx + dvy * dvy;

  let tau = 1;
  if (lenSq > 1e-18) {
    tau = -(rx0 * dvx + ry0 * dvy) / lenSq;
    if (tau < 0) tau = 0;
    if (tau > 1) tau = 1;
  }

  const rx = rx0 + dvx * tau;
  const ry = ry0 + dvy * tau;
  return {
    dist: Math.hypot(rx, ry),
    point: {
      x: m0.x + (m1.x - m0.x) * tau,
      y: m0.y + (m1.y - m0.y) * tau,
    },
  };
}

function isTargetRfJammedForSeeker(
  world: WorldState,
  targetPos: Vec2,
  targetFaction: FactionId,
): boolean {
  for (const unit of world.units.values()) {
    if (
      unit.faction !== targetFaction ||
      unit.hp <= 0 ||
      !unit.jammerActive ||
      unit.emconSilent ||
      unit.subsystems.sensors === 'offline'
    ) {
      continue;
    }
    const dist = Math.hypot(unit.pos.x - targetPos.x, unit.pos.y - targetPos.y);
    if (dist <= SENSOR_CONSTANTS.jammerEffectRangeAu) {
      return true;
    }
  }
  return false;
}

function computeInitialInterceptDeltaV(
  shooter: UnitEntity,
  aimPos: Vec2,
  aimVel: Vec2,
  targetOrbit: ReturnType<typeof stateToOrbit> | undefined,
  maxBoostDv: number,
  nowSec: number,
  spreadIndex: number,
  totalCount: number,
): Vec2 {
  const dist0 = Math.max(1e-5, Math.hypot(aimPos.x - shooter.pos.x, aimPos.y - shooter.pos.y));
  const closingSpeed = Math.max(0.0025, maxBoostDv * 0.85);
  const baseFlightSec = Math.max(1.2, Math.min(180, dist0 / closingSpeed));

  const predictTargetAt = (tSec: number): Vec2 => {
    if (targetOrbit) {
      return orbitToState(targetOrbit, tSec).pos;
    }
    const dt = tSec - nowSec;
    return {
      x: aimPos.x + aimVel.x * dt,
      y: aimPos.y + aimVel.y * dt,
    };
  };

  // Refine flight time in the shooter's co-moving orbital frame so orbital motion doesn't blow up lead distance
  let estFlightSec = baseFlightSec;
  for (let iter = 0; iter < 3; iter++) {
    const tArr = nowSec + estFlightSec;
    const targetAtArr = predictTargetAt(tArr);
    const shooterCoastAtArr = orbitToState(shooter.orbit, tArr).pos;
    const comovingGap = Math.max(
      1e-5,
      Math.hypot(targetAtArr.x - shooterCoastAtArr.x, targetAtArr.y - shooterCoastAtArr.y),
    );
    estFlightSec = Math.max(1.0, Math.min(180, comovingGap / closingSpeed));
  }

  let dv: Vec2 | null = null;

  // Try Lambert intercept across candidate flight durations near estFlightSec
  if (dist0 > 0.025) {
    const dtFactors = [0.65, 0.85, 1.0, 1.2, 1.45, 1.8];
    let bestFeasibleDv: Vec2 | null = null;
    let bestInfeasibleDv: Vec2 | null = null;
    let bestInfeasibleMag = Number.POSITIVE_INFINITY;

    for (const f of dtFactors) {
      const candDt = Math.max(1.5, Math.min(200, estFlightSec * f));
      const arrPos = predictTargetAt(nowSec + candDt);
      const lambert = solveLambertTransfer(shooter.pos, arrPos, candDt, nowSec);
      if (!lambert) {
        continue;
      }
      const req = {
        x: lambert.v1.x - shooter.vel.x,
        y: lambert.v1.y - shooter.vel.y,
      };
      const reqMag = Math.hypot(req.x, req.y);
      if (reqMag <= maxBoostDv) {
        bestFeasibleDv = req;
        break;
      }
      if (reqMag < bestInfeasibleMag) {
        bestInfeasibleMag = reqMag;
        bestInfeasibleDv = {
          x: (req.x / reqMag) * maxBoostDv,
          y: (req.y / reqMag) * maxBoostDv,
        };
      }
    }

    dv = bestFeasibleDv ?? bestInfeasibleDv;
  }

  if (!dv) {
    const tArr = nowSec + estFlightSec;
    const targetAtArr = predictTargetAt(tArr);
    const shooterCoastAtArr = orbitToState(shooter.orbit, tArr).pos;
    const rx = targetAtArr.x - shooterCoastAtArr.x;
    const ry = targetAtArr.y - shooterCoastAtArr.y;
    const rLen = Math.max(1e-6, Math.hypot(rx, ry));
    const req = {
      x: (rx / rLen) * closingSpeed,
      y: (ry / rLen) * closingSpeed,
    };
    const reqMag = Math.hypot(req.x, req.y);
    const scale = reqMag > maxBoostDv ? maxBoostDv / reqMag : 1;
    dv = { x: req.x * scale, y: req.y * scale };
  }

  // Slight angular spread for multi-munition salvos
  if (totalCount > 1) {
    const centered = spreadIndex - (totalCount - 1) * 0.5;
    const spreadRad = centered * 0.004;
    const cosA = Math.cos(spreadRad);
    const sinA = Math.sin(spreadRad);
    dv = {
      x: dv.x * cosA - dv.y * sinA,
      y: dv.x * sinA + dv.y * cosA,
    };
  }

  return dv;
}

/**
 * Validates and spawns a salvo of unified `MunitionEntity` projectiles from `unitId`
 * toward an authoritative faction `targetTrackId` (supporting both enemy ships and in-flight
 * enemy munitions for big-map anti-missile interception).
 */
export function fireMunitionSalvo(
  world: WorldState,
  faction: FactionId,
  params: {
    unitId: string;
    targetTrackId: string;
    profileId: MunitionProfileId;
    count: number;
    coldCoast: boolean;
  },
): CommandValidationResult & { munitionIds?: string[] } {
  const shooter = world.units.get(params.unitId);
  if (!shooter) {
    return { accepted: false, reason: `Unknown unit: ${params.unitId}` };
  }
  if (shooter.faction !== faction) {
    return { accepted: false, reason: `Unit ${params.unitId} does not belong to faction ${faction}` };
  }
  if (shooter.hp <= 0) {
    return { accepted: false, reason: 'Launching unit is destroyed' };
  }
  if (shooter.subsystems.weapons === 'offline') {
    return { accepted: false, reason: 'Weapons subsystem is offline' };
  }

  if (!Number.isInteger(params.count) || params.count < 1 || params.count > MUNITION_CONSTANTS.maxSalvoCount) {
    return { accepted: false, reason: `Invalid salvo count: ${params.count}` };
  }

  const profile = MUNITION_CONFIGS[params.profileId];
  if (!profile) {
    return { accepted: false, reason: `Unknown munition profile: ${params.profileId}` };
  }

  const effectiveCount =
    shooter.subsystems.weapons === 'damaged'
      ? Math.max(1, Math.floor(params.count / 2))
      : params.count;

  if (shooter.ammoStock < effectiveCount) {
    return { accepted: false, reason: 'Insufficient munition ammo stock' };
  }

  const resolved = resolveTrackTargetForFiring(world, faction, params.targetTrackId);
  if (!resolved.target) {
    return { accepted: false, reason: resolved.error ?? 'Target track not lockable' };
  }

  const { record, entity, aimPos, aimVel } = resolved.target;
  const targetKind: 'unit' | 'munition' =
    record.suspectedKind === 'munition' || (entity !== undefined && 'profileId' in entity)
      ? 'munition'
      : 'unit';

  const effectiveColdCoast = params.coldCoast && profile.canColdCoast;
  const boostFraction = effectiveColdCoast
    ? MUNITION_CONSTANTS.defaultBoostFractionCold
    : MUNITION_CONSTANTS.defaultBoostFractionHot;
  const maxBoostDv = profile.maxDeltaV * boostFraction;

  let targetOrbit = record.lastConfirmedOrbit;
  if (!targetOrbit) {
    try {
      const h = aimPos.x * aimVel.y - aimPos.y * aimVel.x;
      if (h > 1e-9) {
        targetOrbit = stateToOrbit(aimPos, aimVel, world.gameTimeSec);
      }
    } catch {
      targetOrbit = undefined;
    }
  }

  const munitionIds: string[] = [];
  for (let i = 0; i < effectiveCount; i++) {
    const seq = world.nextMunitionSeqByFaction[faction];
    world.nextMunitionSeqByFaction[faction] = seq + 1;
    const munId = `${faction}-mun-${seq}`;

    const dvLaunch = computeInitialInterceptDeltaV(
      shooter,
      aimPos,
      aimVel,
      targetOrbit,
      maxBoostDv,
      world.gameTimeSec,
      i,
      effectiveCount,
    );

    const launchBurn = applyImpulsiveBurn(
      { pos: shooter.pos, vel: shooter.vel },
      dvLaunch,
      profile.maxDeltaV,
      world.gameTimeSec,
    );

    const munition: MunitionEntity = {
      id: munId,
      faction,
      profileId: params.profileId,
      pos: launchBurn.state.pos,
      vel: launchBurn.state.vel,
      orbit: launchBurn.orbit,
      deltaV: launchBurn.remainingDeltaV,
      targetId: record.targetId,
      seekerMode: profile.defaultSeekerMode,
      coldCoast: effectiveColdCoast,
      intercepted: false,
    };

    const meta: MunitionRuntimeMeta = {
      launchedAtSec: world.gameTimeSec,
      maxFlightSec: MUNITION_CONSTANTS.maxFlightSec,
      hp: profile.hp,
      aimPos: { ...aimPos },
      aimVel: { ...aimVel },
      targetKind,
      seekerActive: !effectiveColdCoast,
    };

    world.munitions.set(munId, munition);
    world.munitionMeta.set(munId, meta);
    munitionIds.push(munId);
  }

  world.units.set(shooter.id, {
    ...shooter,
    ammoStock: shooter.ammoStock - effectiveCount,
  });

  world.vfxEvents.push({
    kind: 'burn_flash',
    from: { ...shooter.pos },
    intensity: effectiveColdCoast ? 0.12 : 0.45,
  });

  return { accepted: true, munitionIds };
}

function selectSeekerTarget(
  world: WorldState,
  munition: MunitionEntity,
  meta: MunitionRuntimeMeta,
  seekerRangeAu: number,
): { targetUnit?: UnitEntity; targetMunition?: MunitionEntity; jammedBlind: boolean } {
  if (meta.targetKind === 'munition') {
    const directMun = world.munitions.get(munition.targetId);
    if (
      directMun &&
      !directMun.intercepted &&
      directMun.faction !== munition.faction &&
      !isOccluded(munition.pos, directMun.pos, world.celestials, world.gameTimeSec)
    ) {
      const dist = Math.hypot(directMun.pos.x - munition.pos.x, directMun.pos.y - munition.pos.y);
      if (dist <= seekerRangeAu * 1.5) {
        return { targetMunition: directMun, jammedBlind: false };
      }
    }

    // Re-acquire nearest unoccluded enemy munition within seeker range
    let bestMun: MunitionEntity | undefined;
    let bestDist = seekerRangeAu;
    for (const cand of world.munitions.values()) {
      if (cand.faction === munition.faction || cand.intercepted) {
        continue;
      }
      const d = Math.hypot(cand.pos.x - munition.pos.x, cand.pos.y - munition.pos.y);
      if (d <= bestDist && !isOccluded(munition.pos, cand.pos, world.celestials, world.gameTimeSec)) {
        bestDist = d;
        bestMun = cand;
      }
    }
    return { targetMunition: bestMun, jammedBlind: false };
  }

  const directUnit = world.units.get(munition.targetId);
  const liveDirect =
    directUnit &&
    directUnit.hp > 0 &&
    directUnit.faction !== munition.faction &&
    !isOccluded(munition.pos, directUnit.pos, world.celestials, world.gameTimeSec)
      ? directUnit
      : undefined;

  const usesRadarSeeker =
    munition.seekerMode === 'radar' || munition.seekerMode === 'inertial_then_active';
  const jammed =
    usesRadarSeeker &&
    liveDirect !== undefined &&
    isTargetRfJammedForSeeker(world, liveDirect.pos, liveDirect.faction);

  // Check active EW decoy drones within seeker cone/range
  let bestDecoy: UnitEntity | undefined;
  let bestDecoyScore = -1;
  for (const unit of world.units.values()) {
    if (
      unit.faction === munition.faction ||
      unit.hp <= 0 ||
      unit.kind !== 'drone_ew' ||
      unit.emconSilent
    ) {
      continue;
    }
    const d = Math.hypot(unit.pos.x - munition.pos.x, unit.pos.y - munition.pos.y);
    if (d > seekerRangeAu) {
      continue;
    }
    if (isOccluded(munition.pos, unit.pos, world.celestials, world.gameTimeSec)) {
      continue;
    }
    const cfg = UNIT_CONFIGS[unit.kind];
    const score =
      (usesRadarSeeker ? cfg.rcs * MUNITION_CONSTANTS.decoyRcsBias : cfg.passiveRadiatorIr * MUNITION_CONSTANTS.decoyIrBias) /
      Math.max(0.01, d * d);
    if (score > bestDecoyScore) {
      bestDecoyScore = score;
      bestDecoy = unit;
    }
  }

  if (bestDecoy) {
    if (jammed || !liveDirect) {
      return { targetUnit: bestDecoy, jammedBlind: false };
    }
    const directDist = Math.hypot(liveDirect.pos.x - munition.pos.x, liveDirect.pos.y - munition.pos.y);
    const directCfg = UNIT_CONFIGS[liveDirect.kind];
    const targetScore =
      (usesRadarSeeker ? directCfg.rcs : directCfg.passiveRadiatorIr) /
      Math.max(0.01, directDist * directDist);
    // Decoys pull seekers off stealthy ships or whenever decoy signature dominates
    if (liveDirect.emconSilent || bestDecoyScore > targetScore) {
      return { targetUnit: bestDecoy, jammedBlind: false };
    }
  }

  if (jammed && liveDirect) {
    const d = Math.hypot(liveDirect.pos.x - munition.pos.x, liveDirect.pos.y - munition.pos.y);
    // Heavy RF jamming breaks terminal radar lock except at point-blank burn-through
    if (d > 0.015) {
      return { targetUnit: undefined, jammedBlind: true };
    }
  }

  if (liveDirect) {
    const d = Math.hypot(liveDirect.pos.x - munition.pos.x, liveDirect.pos.y - munition.pos.y);
    if (d <= seekerRangeAu * 1.4) {
      return { targetUnit: liveDirect, jammedBlind: false };
    }
  }

  return { targetUnit: undefined, jammedBlind: false };
}

/**
 * Advances all in-flight munitions by one tick:
 * 1. Prunes munitions intercepted on earlier ticks.
 * 2. Propagates Keplerian orbits inertially, transitions cold-coast -> terminal homing,
 *    applies EW jamming & decoy deception, and steers terminal proportional pursuit.
 * 3. Resolves kinetic anti-missile intercepts and unit impacts (invoking CIWS/damage hooks).
 */
export function stepMunitionsSystem(
  world: WorldState,
  dtSec: number,
  hooks: MunitionSystemHooks = {},
): void {
  // Prune previously intercepted munitions so they stay observable for 1 snapshot tick
  for (const [munId, mun] of world.munitions.entries()) {
    const meta = world.munitionMeta.get(munId);
    if (mun.intercepted && (meta?.interceptedAtTick ?? world.tick - 1) < world.tick) {
      world.munitions.delete(munId);
      world.munitionMeta.delete(munId);
    }
  }

  const prevMunPos = new Map<string, Vec2>();
  for (const [munId, mun] of world.munitions.entries()) {
    if (!mun.intercepted) {
      prevMunPos.set(munId, { ...mun.pos });
    }
  }

  for (const [munId, mun] of world.munitions.entries()) {
    if (mun.intercepted) {
      continue;
    }

    const profile = MUNITION_CONFIGS[mun.profileId];
    const meta = world.munitionMeta.get(munId) ?? {
      launchedAtSec: world.gameTimeSec,
      maxFlightSec: MUNITION_CONSTANTS.maxFlightSec,
      hp: profile.hp,
      aimPos: { ...mun.pos },
      aimVel: { x: 0, y: 0 },
      targetKind: 'unit' as const,
      seekerActive: !mun.coldCoast,
    };
    world.munitionMeta.set(munId, meta);

    // Expire out-of-time munitions
    if (world.gameTimeSec - meta.launchedAtSec >= meta.maxFlightSec) {
      mun.intercepted = true;
      meta.interceptedAtTick = world.tick;
      continue;
    }

    const oldPos = prevMunPos.get(munId) ?? { ...mun.pos };
    const propagated = orbitToState(mun.orbit, world.gameTimeSec);
    let curPos = propagated.pos;
    let curVel = propagated.vel;
    let curOrbit = mun.orbit;
    let curDeltaV = mun.deltaV;
    let coldCoast = mun.coldCoast;
    let targetId = mun.targetId;

    meta.aimPos = {
      x: meta.aimPos.x + meta.aimVel.x * dtSec,
      y: meta.aimPos.y + meta.aimVel.y * dtSec,
    };

    // Cold-coast -> terminal seeker activation once within seeker range
    if (coldCoast) {
      const flightAge = world.gameTimeSec - meta.launchedAtSec;
      const distToAim = Math.hypot(meta.aimPos.x - curPos.x, meta.aimPos.y - curPos.y);
      const liveTarget =
        meta.targetKind === 'munition'
          ? world.munitions.get(targetId)
          : world.units.get(targetId);
      const distToLive = liveTarget
        ? Math.hypot(liveTarget.pos.x - curPos.x, liveTarget.pos.y - curPos.y)
        : Number.POSITIVE_INFINITY;

      if (
        flightAge >= MUNITION_CONSTANTS.coldCoastMinSec &&
        (distToAim <= profile.seekerRangeAu || distToLive <= profile.seekerRangeAu)
      ) {
        coldCoast = false;
        meta.seekerActive = true;
        world.vfxEvents.push({
          kind: 'burn_flash',
          from: { ...curPos },
          intensity: 0.35,
        });
      }
    }

    // Active terminal seeker guidance
    if (!coldCoast && curDeltaV > 0) {
      const acquired = selectSeekerTarget(
        world,
        { ...mun, pos: curPos, vel: curVel, coldCoast, targetId },
        meta,
        profile.seekerRangeAu,
      );

      const lockEntity = acquired.targetMunition ?? acquired.targetUnit;
      if (lockEntity) {
        if (lockEntity.id !== targetId) {
          targetId = lockEntity.id;
          if (acquired.targetUnit?.kind === 'drone_ew') {
            meta.decoyDistractedId = lockEntity.id;
          }
        }

        const dx = lockEntity.pos.x - curPos.x;
        const dy = lockEntity.pos.y - curPos.y;
        const dist = Math.max(1e-6, Math.hypot(dx, dy));
        const relVx = curVel.x - lockEntity.vel.x;
        const relVy = curVel.y - lockEntity.vel.y;
        const relSpeed = Math.hypot(relVx, relVy);
        const estTGo = Math.max(0.4, Math.min(35, dist / Math.max(0.003, relSpeed)));

        // Evaluate Keplerian Zero-Effort Miss (ZEM) at predicted closest approach
        let bestTau = estTGo;
        let bestMissVec = { x: dx, y: dy };
        let bestMissDist = Number.POSITIVE_INFINITY;
        const tauSteps = 6;
        for (let k = 1; k <= tauSteps; k++) {
          const tau = Math.max(0.2, (estTGo * 1.4 * k) / tauSteps);
          const futureMun = orbitToState(curOrbit, world.gameTimeSec + tau).pos;
          const futureTgt = orbitToState(lockEntity.orbit, world.gameTimeSec + tau).pos;
          const mx = futureTgt.x - futureMun.x;
          const my = futureTgt.y - futureMun.y;
          const md = Math.hypot(mx, my);
          if (md < bestMissDist) {
            bestMissDist = md;
            bestTau = tau;
            bestMissVec = { x: mx, y: my };
          }
        }

        // Only burn when predicted miss exceeds half the intercept radius, or to boost low closing rate
        let dvCmd = { x: 0, y: 0 };
        if (bestMissDist > profile.interceptRadiusAu * 0.4) {
          const gain = 1.5;
          dvCmd = {
            x: (bestMissVec.x / Math.max(0.3, bestTau)) * gain,
            y: (bestMissVec.y / Math.max(0.3, bestTau)) * gain,
          };
        } else if (relSpeed < 0.003) {
          dvCmd = {
            x: (dx / dist) * 0.002,
            y: (dy / dist) * 0.002,
          };
        }

        const dvCmdMag = Math.hypot(dvCmd.x, dvCmd.y);
        const stepCap = Math.min(profile.maxAccelAuPerSec2 * dtSec, curDeltaV, dvCmdMag);

        if (stepCap > 1e-12 && dvCmdMag > 1e-12) {
          const reqDv = {
            x: (dvCmd.x / dvCmdMag) * stepCap,
            y: (dvCmd.y / dvCmdMag) * stepCap,
          };
          const burn = applyImpulsiveBurn(
            { pos: curPos, vel: curVel },
            reqDv,
            curDeltaV,
            world.gameTimeSec,
          );
          curPos = burn.state.pos;
          curVel = burn.state.vel;
          curOrbit = burn.orbit;
          curDeltaV = burn.remainingDeltaV;
        }
      }
    }

    const updatedMun: MunitionEntity = {
      ...mun,
      pos: curPos,
      vel: curVel,
      orbit: curOrbit,
      deltaV: curDeltaV,
      targetId,
      coldCoast,
    };

    // Impact / intercept check against tracked target
    if (meta.targetKind === 'munition') {
      const targetMun = world.munitions.get(targetId);
      if (targetMun && !targetMun.intercepted && targetMun.faction !== updatedMun.faction) {
        const targetPrev = prevMunPos.get(targetId) ?? targetMun.pos;
        const approach = segmentClosestApproach(oldPos, curPos, targetPrev, targetMun.pos);
        if (approach.dist <= profile.interceptRadiusAu) {
          const targetMeta = world.munitionMeta.get(targetId);
          const interceptDamage = profile.damage * MUNITION_CONSTANTS.kineticAntiMissileMultiplier;
          if (targetMeta) {
            targetMeta.hp = Math.max(0, targetMeta.hp - interceptDamage);
            if (targetMeta.hp <= 0) {
              targetMun.intercepted = true;
              targetMeta.interceptedAtTick = world.tick;
            }
          } else {
            targetMun.intercepted = true;
          }

          updatedMun.intercepted = true;
          meta.interceptedAtTick = world.tick;
          world.vfxEvents.push({
            kind: 'explosion',
            from: approach.point,
            intensity: 0.75,
          });
        }
      }
    } else {
      const targetUnit = world.units.get(targetId);
      if (targetUnit && targetUnit.hp > 0 && targetUnit.faction !== updatedMun.faction) {
        const targetPrev = {
          x: targetUnit.pos.x - targetUnit.vel.x * dtSec,
          y: targetUnit.pos.y - targetUnit.vel.y * dtSec,
        };
        const approach = segmentClosestApproach(oldPos, curPos, targetPrev, targetUnit.pos);
        if (approach.dist <= profile.interceptRadiusAu) {
          const interceptedByCiws = hooks.ciwsIntercept
            ? hooks.ciwsIntercept(world, updatedMun, targetUnit)
            : false;

          updatedMun.intercepted = true;
          meta.interceptedAtTick = world.tick;

          if (!interceptedByCiws) {
            if (hooks.warheadImpact) {
              hooks.warheadImpact(world, targetUnit, profile.damage, updatedMun);
            } else {
              world.units.set(targetUnit.id, {
                ...targetUnit,
                hp: Math.max(0, targetUnit.hp - profile.damage),
              });
            }
            world.vfxEvents.push({
              kind: 'explosion',
              from: { ...targetUnit.pos },
              intensity: profile.id === 'heavy_torpedo' ? 1.0 : 0.65,
            });
          }
        }
      }
    }

    world.munitions.set(munId, updatedMun);
  }
}

/**
 * Creates a SimulationLoop system hook advancing unified munitions in `pre_thermal` phase.
 */
export function createMunitionTickSystem(hooks: MunitionSystemHooks = {}): TickSystemHook {
  return ({ world, dtSec }) => {
    stepMunitionsSystem(world, dtSec, hooks);
  };
}
