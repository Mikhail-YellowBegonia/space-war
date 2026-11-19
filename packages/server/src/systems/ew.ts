import {
  UNIT_CONFIGS,
  applyImpulsiveBurn,
  isOccluded,
  orbitToState,
  solveOrbitInsertion,
  type FactionId,
  type KeplerOrbit,
  type UnitEntity,
} from '@space-war/shared';
import type { CommandValidationResult } from '../engine/commandPipeline.js';
import type { TickSystemHook } from '../engine/simulationLoop.js';
import { createUnitEntity, getWorldOccluders, type WorldState } from '../engine/worldState.js';

export const EW_CONSTANTS = {
  dazzleDurationSec: 4.0,
  droneSeparationDeltaV: 0.0008,
  droneEwDecoyIrBoost: 4.5,
} as const;

function wrapSignedAngle(rad: number): number {
  let wrapped = (rad + Math.PI) % (2 * Math.PI);
  if (wrapped < 0) {
    wrapped += 2 * Math.PI;
  }
  return wrapped - Math.PI;
}

/**
 * Applies a short-range blinding laser dazzle from `attacker` to `target`,
 * temporarily suppressing the target's passive optical and IR sensors.
 */
export function applyLaserDazzle(
  world: WorldState,
  attacker: UnitEntity,
  target: UnitEntity,
  durationSec = EW_CONSTANTS.dazzleDurationSec,
): boolean {
  if (
    attacker.hp <= 0 ||
    target.hp <= 0 ||
    attacker.faction === target.faction ||
    attacker.emconSilent ||
    attacker.subsystems.weapons === 'offline'
  ) {
    return false;
  }

  const attackerCfg = UNIT_CONFIGS[attacker.kind];
  if (attackerCfg.weapons.laserDps <= 0 || attackerCfg.weapons.laserRangeAu <= 0) {
    return false;
  }

  const dist = Math.hypot(target.pos.x - attacker.pos.x, target.pos.y - attacker.pos.y);
  if (dist > attackerCfg.weapons.laserRangeAu) {
    return false;
  }

  if (isOccluded(attacker.pos, target.pos, getWorldOccluders(world), world.gameTimeSec)) {
    return false;
  }

  const prevUntil = world.sensorBlindUntilSec.get(target.id) ?? 0;
  world.sensorBlindUntilSec.set(target.id, Math.max(prevUntil, world.gameTimeSec + durationSec));
  world.vfxEvents.push({
    kind: 'laser',
    from: { ...attacker.pos },
    to: { ...target.pos },
    intensity: 0.7,
  });
  return true;
}

/**
 * Launches a `drone_recon` or `drone_ew` from an owned carrier unit within its droneCapacity.
 */
export function launchCarrierDrone(
  world: WorldState,
  faction: FactionId,
  carrierId: string,
  droneKind: 'drone_recon' | 'drone_ew',
  targetOrbit?: KeplerOrbit,
): CommandValidationResult & { droneId?: string } {
  const carrier = world.units.get(carrierId);
  if (!carrier) {
    return { accepted: false, reason: `Unknown unit: ${carrierId}` };
  }
  if (carrier.faction !== faction) {
    return { accepted: false, reason: `Unit ${carrierId} does not belong to faction ${faction}` };
  }
  if (carrier.hp <= 0) {
    return { accepted: false, reason: 'Carrier unit is destroyed' };
  }

  const carrierCfg = UNIT_CONFIGS[carrier.kind];
  const capacity = carrierCfg.weapons.droneCapacity;
  if (capacity <= 0) {
    return { accepted: false, reason: `${carrier.kind} has no drone bay` };
  }

  const launchedSoFar = world.launchedDronesByCarrier.get(carrier.id) ?? 0;
  if (launchedSoFar >= capacity) {
    return { accepted: false, reason: 'Carrier drone bay capacity exhausted' };
  }

  if (targetOrbit) {
    const { a, e } = targetOrbit;
    if (!Number.isFinite(a) || a <= 0.1 || a >= 6.0 || !Number.isFinite(e) || e < 0 || e >= 0.92) {
      return { accepted: false, reason: 'Target orbital elements out of bounds' };
    }
  }

  const droneId = `${carrier.id}-${droneKind}-${launchedSoFar + 1}`;
  let drone = createUnitEntity({
    id: droneId,
    faction,
    kind: droneKind,
    orbit: carrier.orbit,
    gameTimeSec: world.gameTimeSec,
    // Recon drones launch quiet; EW decoy drones emit active decoy radar/radiator signature
    emconSilent: droneKind === 'drone_recon',
    radarActive: droneKind === 'drone_ew',
  });

  if (targetOrbit) {
    const plan = solveOrbitInsertion(
      {
        unit: drone,
        nowSec: world.gameTimeSec,
        celestialBodies: world.celestials,
      },
      targetOrbit,
    );
    const chosen = drone.propulsion === 'electric' ? plan.stealth : plan.fuel;
    if (!chosen.feasible) {
      return { accepted: false, reason: chosen.reason ?? 'Drone transfer infeasible' };
    }
    drone = {
      ...drone,
      plannedBurns: chosen.burns.map((b) => ({ ...b, deltaV: { ...b.deltaV } })),
    };
  } else {
    // Apply a small separation impulse perpendicular/radial to build parallax baseline cleanly
    const r = Math.max(1e-6, Math.hypot(carrier.pos.x, carrier.pos.y));
    const radialDv = {
      x: (carrier.pos.x / r) * EW_CONSTANTS.droneSeparationDeltaV,
      y: (carrier.pos.y / r) * EW_CONSTANTS.droneSeparationDeltaV,
    };
    const sepBurn = applyImpulsiveBurn(
      orbitToState(carrier.orbit, world.gameTimeSec),
      radialDv,
      drone.deltaV,
      world.gameTimeSec,
    );
    drone = {
      ...drone,
      pos: sepBurn.state.pos,
      vel: sepBurn.state.vel,
      orbit: sepBurn.orbit,
      deltaV: sepBurn.remainingDeltaV,
    };
  }

  world.launchedDronesByCarrier.set(carrier.id, launchedSoFar + 1);
  world.units.set(drone.id, drone);
  return { accepted: true, droneId };
}

/**
 * Advances active EW blinding-laser illumination and expires elapsed sensor-blindness timers.
 */
export function stepEwSystem(world: WorldState, _dtSec = 0.1): void {
  for (const [unitId, untilSec] of world.sensorBlindUntilSec.entries()) {
    if (untilSec <= world.gameTimeSec) {
      world.sensorBlindUntilSec.delete(unitId);
    }
  }

  for (const attacker of world.units.values()) {
    if (
      attacker.hp <= 0 ||
      attacker.emconSilent ||
      attacker.ladarTargetAngle === undefined ||
      attacker.subsystems.weapons === 'offline' ||
      attacker.subsystems.sensors === 'offline'
    ) {
      continue;
    }

    const attackerCfg = UNIT_CONFIGS[attacker.kind];
    if (attackerCfg.weapons.laserDps <= 0 || attackerCfg.weapons.laserRangeAu <= 0) {
      continue;
    }

    const halfCone = Math.max(0.08, attackerCfg.sensors.ladarConeRad * 0.5);
    let firedDazzle = false;

    for (const target of world.units.values()) {
      if (target.faction === attacker.faction || target.hp <= 0) {
        continue;
      }
      const dx = target.pos.x - attacker.pos.x;
      const dy = target.pos.y - attacker.pos.y;
      const dist = Math.hypot(dx, dy);
      if (dist > attackerCfg.weapons.laserRangeAu) {
        continue;
      }
      const angle = Math.atan2(dy, dx);
      if (Math.abs(wrapSignedAngle(angle - attacker.ladarTargetAngle)) > halfCone) {
        continue;
      }
      if (applyLaserDazzle(world, attacker, target, EW_CONSTANTS.dazzleDurationSec)) {
        firedDazzle = true;
      }
    }

    if (firedDazzle) {
      world.laserActiveUnitIds.add(attacker.id);
    }
  }
}

/**
 * Creates a SimulationLoop system hook running active EW dazzling and timer maintenance.
 */
export function createEwTickSystem(): TickSystemHook {
  return ({ world, dtSec }) => {
    stepEwSystem(world, dtSec);
  };
}
