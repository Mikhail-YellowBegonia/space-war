import { PROPULSION_CONFIGS } from '../config/index.js';
import type {
  KeplerOrbit,
  PropulsionType,
  SubsystemHealth,
  TransferBurn,
  UnitEntity,
  Vec2,
} from '../types/index.js';
import {
  getSpecificOrbitalEnergy,
  MAX_KEPLER_ECCENTRICITY,
  MU_SUN,
  orbitToState,
  stateToOrbit,
  type OrbitalState,
} from './ephemeris.js';

export interface BurnStepResult {
  state: OrbitalState;
  orbit: KeplerOrbit;
  usedDeltaV: number;
  appliedDeltaV: Vec2;
  remainingDeltaV: number;
}

export interface ContinuousThrustOptions {
  subSteps?: number;
  propulsionHealth?: SubsystemHealth;
}

export interface UnitOrbitAdvanceResult {
  unit: UnitEntity;
  usedDeltaV: number;
  appliedDeltaV: Vec2;
  activeBurn: boolean;
}

const EPSILON = 1e-12;
const SAFE_MAX_ECCENTRICITY = MAX_KEPLER_ECCENTRICITY - 0.002;

/**
 * Returns the thrust efficiency multiplier for a unit's propulsion subsystem health.
 */
export function getPropulsionThrustFactor(health: SubsystemHealth): number {
  switch (health) {
    case 'normal':
      return 1;
    case 'damaged':
      return 0.5;
    case 'offline':
      return 0;
  }
}

/**
 * Returns effective maximum thrust acceleration in AU/s^2 for a propulsion system and health.
 */
export function getEffectiveMaxAccelAuPerSec2(
  propulsion: PropulsionType,
  health: SubsystemHealth = 'normal',
): number {
  return PROPULSION_CONFIGS[propulsion].maxAccelAuPerSec2 * getPropulsionThrustFactor(health);
}

function isValidBoundProgradeOrbit(pos: Vec2, vel: Vec2): boolean {
  const r = Math.hypot(pos.x, pos.y);
  if (r <= EPSILON) {
    return false;
  }
  const h = pos.x * vel.y - pos.y * vel.x;
  if (h <= 1e-9) {
    return false;
  }
  const energy = getSpecificOrbitalEnergy(pos, vel);
  if (energy >= -1e-9) {
    return false;
  }
  const ex = (vel.y * h) / MU_SUN - pos.x / r;
  const ey = -(vel.x * h) / MU_SUN - pos.y / r;
  const e = Math.hypot(ex, ey);
  return Number.isFinite(e) && e <= SAFE_MAX_ECCENTRICITY;
}

function clampDeltaVToBoundOrbit(pos: Vec2, vel: Vec2, dv: Vec2): Vec2 {
  const candidate = { x: vel.x + dv.x, y: vel.y + dv.y };
  if (isValidBoundProgradeOrbit(pos, candidate)) {
    return dv;
  }

  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = 0.5 * (lo + hi);
    const testVel = { x: vel.x + dv.x * mid, y: vel.y + dv.y * mid };
    if (isValidBoundProgradeOrbit(pos, testVel)) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  return { x: dv.x * lo, y: dv.y * lo };
}

/**
 * Applies an instantaneous impulsive burn at tSec, capped by availableDeltaV.
 * Locks strictly to pure inertial coasting when availableDeltaV <= 0 or propulsion is offline.
 */
export function applyImpulsiveBurn(
  state: OrbitalState,
  requestedDeltaV: Vec2,
  availableDeltaV: number,
  tSec: number,
  propulsionHealth: SubsystemHealth = 'normal',
): BurnStepResult {
  const safeAvail = Math.max(0, availableDeltaV);
  const reqMag = Math.hypot(requestedDeltaV.x, requestedDeltaV.y);

  if (safeAvail <= 0 || propulsionHealth === 'offline' || reqMag <= 1e-15) {
    const orbit = stateToOrbit(state.pos, state.vel, tSec);
    return {
      state: {
        pos: { ...state.pos },
        vel: { ...state.vel },
      },
      orbit,
      usedDeltaV: 0,
      appliedDeltaV: { x: 0, y: 0 },
      remainingDeltaV: safeAvail,
    };
  }

  const capScale = reqMag > safeAvail ? safeAvail / reqMag : 1;
  const cappedDv: Vec2 = {
    x: requestedDeltaV.x * capScale,
    y: requestedDeltaV.y * capScale,
  };
  const appliedDeltaV = clampDeltaVToBoundOrbit(state.pos, state.vel, cappedDv);
  const usedDeltaV = Math.min(safeAvail, Math.hypot(appliedDeltaV.x, appliedDeltaV.y));

  const postVel: Vec2 = {
    x: state.vel.x + appliedDeltaV.x,
    y: state.vel.y + appliedDeltaV.y,
  };
  const orbit = stateToOrbit(state.pos, postVel, tSec);
  const synced = orbitToState(orbit, tSec);

  return {
    state: synced,
    orbit,
    usedDeltaV,
    appliedDeltaV,
    remainingDeltaV: Math.max(0, safeAvail - usedDeltaV),
  };
}

/**
 * Propagates an orbital state over dtSec under continuous thrust (e.g., electric or throttled burn)
 * via sub-stepped Kepler propagation + micro-impulses, deducting deltaV and locking to inertial
 * coasting as soon as availableDeltaV hits 0.
 */
export function stepContinuousThrust(
  state: OrbitalState,
  desiredDeltaV: Vec2,
  dtSec: number,
  availableDeltaV: number,
  propulsion: PropulsionType,
  tSec: number,
  options: ContinuousThrustOptions = {},
): BurnStepResult {
  const safeAvail = Math.max(0, availableDeltaV);
  const health = options.propulsionHealth ?? 'normal';
  const curOrbitStart = stateToOrbit(state.pos, state.vel, tSec);

  if (dtSec <= 0) {
    return {
      state: { pos: { ...state.pos }, vel: { ...state.vel } },
      orbit: curOrbitStart,
      usedDeltaV: 0,
      appliedDeltaV: { x: 0, y: 0 },
      remainingDeltaV: safeAvail,
    };
  }

  const subSteps = Math.max(1, options.subSteps ?? 8);
  const stepDt = dtSec / subSteps;
  const maxAccel = getEffectiveMaxAccelAuPerSec2(propulsion, health);

  let curOrbit = curOrbitStart;
  let curTime = tSec;
  let remAvail = safeAvail;
  let remDx = desiredDeltaV.x;
  let remDy = desiredDeltaV.y;
  let totalUsed = 0;
  let appliedX = 0;
  let appliedY = 0;

  for (let i = 0; i < subSteps; i++) {
    const remDesiredMag = Math.hypot(remDx, remDy);
    if (remAvail <= 1e-15 || maxAccel <= 0 || remDesiredMag <= 1e-15) {
      const endState = orbitToState(curOrbit, tSec + dtSec);
      return {
        state: endState,
        orbit: stateToOrbit(endState.pos, endState.vel, tSec + dtSec),
        usedDeltaV: totalUsed,
        appliedDeltaV: { x: appliedX, y: appliedY },
        remainingDeltaV: remAvail,
      };
    }

    const midTime = curTime + 0.5 * stepDt;
    const midState = orbitToState(curOrbit, midTime);

    const stepCap = Math.min(maxAccel * stepDt, remAvail, remDesiredMag);
    const reqStepDv: Vec2 = {
      x: (remDx / remDesiredMag) * stepCap,
      y: (remDy / remDesiredMag) * stepCap,
    };

    const burn = applyImpulsiveBurn(midState, reqStepDv, remAvail, midTime, health);
    totalUsed += burn.usedDeltaV;
    appliedX += burn.appliedDeltaV.x;
    appliedY += burn.appliedDeltaV.y;
    remAvail = burn.remainingDeltaV;
    remDx -= burn.appliedDeltaV.x;
    remDy -= burn.appliedDeltaV.y;

    curOrbit = burn.orbit;
    curTime += stepDt;
  }

  const endState = orbitToState(curOrbit, tSec + dtSec);
  return {
    state: endState,
    orbit: stateToOrbit(endState.pos, endState.vel, tSec + dtSec),
    usedDeltaV: totalUsed,
    appliedDeltaV: { x: appliedX, y: appliedY },
    remainingDeltaV: remAvail,
  };
}

/**
 * Advances a unit's Keplerian orbit from tSec to tSec + dtSec, executing any scheduled burns
 * according to its propulsion mode (impulsive vs continuous) and locking to pure inertial coasting
 * when deltaV <= 0 or propulsion is offline.
 */
export function advanceUnitOrbit(
  unit: UnitEntity,
  tSec: number,
  dtSec: number,
): UnitOrbitAdvanceResult {
  if (dtSec <= 0) {
    return {
      unit,
      usedDeltaV: 0,
      appliedDeltaV: { x: 0, y: 0 },
      activeBurn: false,
    };
  }

  const tEnd = tSec + dtSec;
  let curTime = tSec;
  let curOrbit = unit.orbit;
  let curState = orbitToState(curOrbit, curTime);
  let remDeltaV = Math.max(0, unit.deltaV);
  let totalUsed = 0;
  let appliedX = 0;
  let appliedY = 0;
  let activeBurn = false;
  const remainingBurns: TransferBurn[] = [];

  const canThrust = remDeltaV > 0 && unit.subsystems.propulsion !== 'offline';
  const burnMode = PROPULSION_CONFIGS[unit.propulsion].burnMode;

  for (const burn of unit.plannedBurns) {
    if (burn.executeAtSec > tEnd + 1e-9) {
      remainingBurns.push(burn);
      continue;
    }

    if (!canThrust || remDeltaV <= 1e-15) {
      // Drop expired past burns when propellant is exhausted, keep only future scheduled entries
      if (burn.executeAtSec + Math.max(0, burn.durationSec) > tEnd + 1e-9) {
        remainingBurns.push(burn);
      }
      continue;
    }

    const isContinuous = burnMode === 'continuous' || burn.durationSec > dtSec + 1e-9;

    if (!isContinuous) {
      const burnTime = Math.max(curTime, Math.min(tEnd, burn.executeAtSec));
      if (burnTime > curTime + 1e-12) {
        curState = orbitToState(curOrbit, burnTime);
        curTime = burnTime;
      }

      const result = applyImpulsiveBurn(
        curState,
        burn.deltaV,
        remDeltaV,
        curTime,
        unit.subsystems.propulsion,
      );
      curState = result.state;
      curOrbit = result.orbit;
      remDeltaV = result.remainingDeltaV;
      totalUsed += result.usedDeltaV;
      appliedX += result.appliedDeltaV.x;
      appliedY += result.appliedDeltaV.y;
      if (result.usedDeltaV > 0) {
        activeBurn = true;
      }
    } else {
      const burnEnd = burn.executeAtSec + Math.max(dtSec, burn.durationSec);
      const segStart = Math.max(curTime, burn.executeAtSec);
      const segEnd = Math.min(tEnd, burnEnd);

      if (segEnd <= segStart + 1e-12) {
        if (burnEnd > tEnd + 1e-9) {
          remainingBurns.push(burn);
        }
        continue;
      }

      if (segStart > curTime + 1e-12) {
        curState = orbitToState(curOrbit, segStart);
        curTime = segStart;
      }

      const segDt = segEnd - segStart;
      const remainingDuration = Math.max(segDt, burnEnd - segStart);
      const fraction = Math.min(1, segDt / remainingDuration);
      const desiredSlice: Vec2 = {
        x: burn.deltaV.x * fraction,
        y: burn.deltaV.y * fraction,
      };

      const result = stepContinuousThrust(
        curState,
        desiredSlice,
        segDt,
        remDeltaV,
        unit.propulsion,
        curTime,
        {
          subSteps: 4,
          propulsionHealth: unit.subsystems.propulsion,
        },
      );

      curState = result.state;
      curOrbit = result.orbit;
      curTime = segEnd;
      remDeltaV = result.remainingDeltaV;
      totalUsed += result.usedDeltaV;
      appliedX += result.appliedDeltaV.x;
      appliedY += result.appliedDeltaV.y;
      if (result.usedDeltaV > 0) {
        activeBurn = true;
      }

      const leftoverDv: Vec2 = {
        x: burn.deltaV.x - result.appliedDeltaV.x,
        y: burn.deltaV.y - result.appliedDeltaV.y,
      };
      const leftoverMag = Math.hypot(leftoverDv.x, leftoverDv.y);
      const leftoverDuration = Math.max(0, burnEnd - segEnd);

      if (leftoverDuration > 1e-6 && leftoverMag > 1e-12 && remDeltaV > 1e-15) {
        remainingBurns.push({
          ...burn,
          executeAtSec: segEnd,
          durationSec: leftoverDuration,
          deltaV: leftoverDv,
        });
      }
    }
  }

  if (curTime < tEnd - 1e-12) {
    curState = orbitToState(curOrbit, tEnd);
    if (totalUsed > 0) {
      curOrbit = stateToOrbit(curState.pos, curState.vel, tEnd);
    }
  }

  return {
    unit: {
      ...unit,
      pos: curState.pos,
      vel: curState.vel,
      orbit: curOrbit,
      deltaV: remDeltaV,
      plannedBurns: remainingBurns,
    },
    usedDeltaV: totalUsed,
    appliedDeltaV: { x: appliedX, y: appliedY },
    activeBurn,
  };
}
