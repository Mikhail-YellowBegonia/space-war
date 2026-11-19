import {
  PROPULSION_CONFIGS,
  UNIT_CONFIGS,
  type SubsystemHealth,
  type UnitEntity,
} from '@space-war/shared';
import type { TickSystemHook } from '../engine/simulationLoop.js';

export interface ThermalActivity {
  usedDeltaV?: number;
  dtSec?: number;
  laserActive?: boolean;
  forcedVenting?: boolean;
}

export interface ThermalStepResult {
  unit: UnitEntity;
  irSignature: number;
  forcedVenting: boolean;
  overheatedDegraded: boolean;
}

/**
 * Returns the cooling rate multiplier for a unit's thermal subsystem health.
 */
export function getThermalSubsystemFactor(health: SubsystemHealth): number {
  switch (health) {
    case 'normal':
      return 1.0;
    case 'damaged':
      return 0.4;
    case 'offline':
      return 0.1;
  }
}

/**
 * Computes instantaneous infrared emission signature for a unit based on hull baseline,
 * radiator deployment & heat load, forced venting, active laser, and propulsion exhaust plume.
 */
export function computeUnitIrSignature(
  unit: UnitEntity,
  activity: ThermalActivity = {},
): number {
  const unitCfg = UNIT_CONFIGS[unit.kind];
  const propCfg = PROPULSION_CONFIGS[unit.propulsion];

  const hullBaseline = unitCfg.passiveRadiatorIr * 0.12;

  let radiatorIr = 0;
  if (unit.radiatorsOpen && !unit.emconSilent) {
    const heatRatio = Math.max(0, Math.min(1, unit.heat / Math.max(1, unit.maxHeat)));
    const ventBoost = activity.forcedVenting ? 1.5 : 1.0;
    radiatorIr = unitCfg.passiveRadiatorIr * (0.5 + 1.5 * heatRatio) * ventBoost;
  }

  const laserIr = activity.laserActive ? unitCfg.weapons.laserHeatPerSec * 2.5 : 0;

  let plumeIr = 0;
  const usedDv = activity.usedDeltaV ?? 0;
  if (usedDv > 0) {
    const dtSec = Math.max(1e-3, activity.dtSec ?? 0.1);
    const accel = usedDv / dtSec;
    plumeIr = (accel / Math.max(1e-6, propCfg.maxAccelAuPerSec2)) * propCfg.irFactor * 5.0;
  }

  return hullBaseline + radiatorIr + laserIr + plumeIr;
}

/**
 * Advances a unit's heat sink balance over dtSec:
 * - Accumulates heat from base power, propulsion burns, active LADAR/laser, and radar/jammer.
 * - Radiates heat when radiators are open and EMCON silent mode is off.
 * - Triggers forced emergency radiator venting or thermal overheat degradation when heat >= maxHeat.
 */
export function stepUnitThermal(
  unit: UnitEntity,
  dtSec: number,
  activity: Omit<ThermalActivity, 'dtSec' | 'forcedVenting'> = {},
): ThermalStepResult {
  if (dtSec <= 0) {
    return {
      unit,
      irSignature: computeUnitIrSignature(unit, { ...activity, dtSec: 0.1 }),
      forcedVenting: false,
      overheatedDegraded: false,
    };
  }

  const unitCfg = UNIT_CONFIGS[unit.kind];
  const propCfg = PROPULSION_CONFIGS[unit.propulsion];

  const baseHeat = unitCfg.baseHeatGenPerSec * dtSec;
  const burnHeat = Math.max(0, activity.usedDeltaV ?? 0) * propCfg.heatPerDeltaV;
  const ladarHeat =
    unit.ladarTargetAngle !== undefined ? unitCfg.sensors.ladarHeatPerSec * dtSec : 0;
  const laserHeat = activity.laserActive ? unitCfg.weapons.laserHeatPerSec * dtSec : 0;
  const ewAuxHeat = ((unit.radarActive ? 0.15 : 0) + (unit.jammerActive ? 0.25 : 0)) * dtSec;

  const totalHeatGen = baseHeat + burnHeat + ladarHeat + laserHeat + ewAuxHeat;

  let cooling = 0;
  if (unit.radiatorsOpen && !unit.emconSilent) {
    cooling =
      unitCfg.radiatorCoolingPerSec * getThermalSubsystemFactor(unit.subsystems.thermal) * dtSec;
  }

  let nextHeat = Math.max(0, unit.heat + totalHeatGen - cooling);
  let emconSilent = unit.emconSilent;
  let radiatorsOpen = unit.radiatorsOpen;
  let radarActive = unit.radarActive;
  let jammerActive = unit.jammerActive;
  let ladarTargetAngle = unit.ladarTargetAngle;
  const subsystems = { ...unit.subsystems };

  let forcedVenting = false;
  let overheatedDegraded = false;

  if (nextHeat >= unit.maxHeat) {
    nextHeat = unit.maxHeat;

    if ((emconSilent || !radiatorsOpen) && subsystems.thermal !== 'offline') {
      emconSilent = false;
      radiatorsOpen = true;
      forcedVenting = true;
    } else {
      overheatedDegraded = true;
    }

    if (subsystems.thermal === 'offline' || subsystems.thermal === 'damaged' || overheatedDegraded) {
      overheatedDegraded = true;
      ladarTargetAngle = undefined;
      radarActive = false;
      jammerActive = false;
      if (subsystems.thermal === 'offline') {
        if (subsystems.weapons === 'normal') {
          subsystems.weapons = 'damaged';
        }
        if (subsystems.sensors === 'normal') {
          subsystems.sensors = 'damaged';
        }
      }
    }
  }

  const updatedUnit: UnitEntity = {
    ...unit,
    heat: nextHeat,
    emconSilent,
    radiatorsOpen,
    radarActive,
    jammerActive,
    ladarTargetAngle,
    subsystems,
  };

  const irSignature = computeUnitIrSignature(updatedUnit, {
    usedDeltaV: activity.usedDeltaV,
    dtSec,
    laserActive: activity.laserActive,
    forcedVenting,
  });

  return {
    unit: updatedUnit,
    irSignature,
    forcedVenting,
    overheatedDegraded,
  };
}

/**
 * Creates a SimulationLoop system hook that updates heat sink load and IR signatures
 * for all units on every tick.
 */
export function createThermalTickSystem(irByUnit?: Map<string, number>): TickSystemHook {
  return ({ world, dtSec, usedDeltaVByUnit }) => {
    for (const [unitId, unit] of world.units.entries()) {
      const result = stepUnitThermal(unit, dtSec, {
        usedDeltaV: usedDeltaVByUnit.get(unitId) ?? 0,
        laserActive: world.laserActiveUnitIds.has(unitId),
      });
      world.units.set(unitId, result.unit);
      irByUnit?.set(unitId, result.irSignature);
    }
  };
}
