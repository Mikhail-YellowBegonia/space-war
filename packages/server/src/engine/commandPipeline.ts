import {
  UNIT_CONFIGS,
  solveInterceptTransfer,
  solveOrbitInsertion,
  type FactionId,
  type InterceptTarget,
  type PlayerCommand,
  type ResupplyPoint,
  type UnitEntity,
} from '@space-war/shared';
import { launchCarrierDrone } from '../systems/ew.js';
import type { WorldState } from './worldState.js';

export interface CommandValidationResult {
  accepted: boolean;
  reason?: string;
}

function getFriendlyResupplySites(world: WorldState, faction: FactionId): ResupplyPoint[] {
  const sites: ResupplyPoint[] = [];
  for (const unit of world.units.values()) {
    if (unit.faction !== faction) {
      continue;
    }
    if (UNIT_CONFIGS[unit.kind].logistics.canResupply) {
      sites.push({ id: unit.id, orbit: unit.orbit, pos: unit.pos });
    }
  }
  return sites;
}

function getOwnedUnit(
  world: WorldState,
  faction: FactionId,
  unitId: string,
): { unit?: UnitEntity; error?: string } {
  const unit = world.units.get(unitId);
  if (!unit) {
    return { error: `Unknown unit: ${unitId}` };
  }
  if (unit.faction !== faction) {
    return { error: `Unit ${unitId} does not belong to faction ${faction}` };
  }
  return { unit };
}

function resolveInterceptTarget(
  world: WorldState,
  faction: FactionId,
  targetRefId: string,
): InterceptTarget | null {
  const body = world.celestials.find((b) => b.id === targetRefId && b.orbit !== null);
  if (body) {
    return body;
  }

  // Only allow direct unit targeting for friendly units (e.g., tanker rendezvous)
  const ownUnit = world.units.get(targetRefId);
  if (ownUnit && ownUnit.faction === faction) {
    return ownUnit;
  }

  // Enemy targets must be resolved through faction sensor tracks (fog-of-war safe)
  const track = world.tracksByFaction[faction].find((t) => t.trackId === targetRefId);
  if (track) {
    return track;
  }

  return null;
}

/**
 * Validates and applies a player command to the authoritative WorldState.
 */
export function applyPlayerCommand(
  world: WorldState,
  faction: FactionId,
  command: PlayerCommand,
): CommandValidationResult {
  if (world.winner !== null) {
    return { accepted: false, reason: 'Match already concluded' };
  }

  switch (command.type) {
    case 'plan_orbit_insertion': {
      const { unit, error } = getOwnedUnit(world, faction, command.unitId);
      if (!unit) {
        return { accepted: false, reason: error };
      }
      if (unit.subsystems.propulsion === 'offline') {
        return { accepted: false, reason: 'Propulsion subsystem is offline' };
      }
      if (unit.deltaV <= 0) {
        return { accepted: false, reason: 'No remaining delta-v' };
      }
      const { a, e } = command.targetOrbit;
      if (!Number.isFinite(a) || a <= 0.1 || a >= 6.0 || !Number.isFinite(e) || e < 0 || e >= 0.92) {
        return { accepted: false, reason: 'Target orbital elements out of bounds' };
      }

      const options = solveOrbitInsertion(
        {
          unit,
          nowSec: world.gameTimeSec,
          celestialBodies: world.celestials,
          friendlyResupplySites: getFriendlyResupplySites(world, faction),
        },
        command.targetOrbit,
      );
      const chosen = options[command.mode];
      if (!chosen.feasible) {
        return { accepted: false, reason: chosen.reason ?? 'Transfer infeasible' };
      }

      world.units.set(unit.id, {
        ...unit,
        plannedBurns: chosen.burns.map((b) => ({ ...b, deltaV: { ...b.deltaV } })),
      });
      return { accepted: true };
    }

    case 'plan_intercept': {
      const { unit, error } = getOwnedUnit(world, faction, command.unitId);
      if (!unit) {
        return { accepted: false, reason: error };
      }
      if (unit.subsystems.propulsion === 'offline') {
        return { accepted: false, reason: 'Propulsion subsystem is offline' };
      }
      if (unit.deltaV <= 0) {
        return { accepted: false, reason: 'No remaining delta-v' };
      }

      const target = resolveInterceptTarget(world, faction, command.targetRefId);
      if (!target) {
        return { accepted: false, reason: `Unknown or unobservable target: ${command.targetRefId}` };
      }

      const options = solveInterceptTransfer(
        {
          unit,
          nowSec: world.gameTimeSec,
          celestialBodies: world.celestials,
          friendlyResupplySites: getFriendlyResupplySites(world, faction),
        },
        target,
      );
      const chosen = options[command.mode];
      if (!chosen.feasible) {
        return { accepted: false, reason: chosen.reason ?? 'Intercept infeasible' };
      }

      world.units.set(unit.id, {
        ...unit,
        plannedBurns: chosen.burns.map((b) => ({ ...b, deltaV: { ...b.deltaV } })),
      });
      return { accepted: true };
    }

    case 'set_emcon': {
      const { unit, error } = getOwnedUnit(world, faction, command.unitId);
      if (!unit) {
        return { accepted: false, reason: error };
      }

      const silent = command.silent;
      world.units.set(unit.id, {
        ...unit,
        emconSilent: silent,
        radiatorsOpen: silent ? false : command.radiatorsOpen,
        radarActive: silent ? false : command.radarActive,
        jammerActive: silent ? false : command.jammerActive,
      });
      return { accepted: true };
    }

    case 'set_ladar': {
      const { unit, error } = getOwnedUnit(world, faction, command.unitId);
      if (!unit) {
        return { accepted: false, reason: error };
      }
      if (command.angleRad !== null && unit.subsystems.sensors === 'offline') {
        return { accepted: false, reason: 'Sensor subsystem is offline' };
      }
      if (command.angleRad !== null && UNIT_CONFIGS[unit.kind].sensors.ladarRangeAu <= 0) {
        return { accepted: false, reason: 'Unit is not equipped with LADAR' };
      }

      world.units.set(unit.id, {
        ...unit,
        ladarTargetAngle: command.angleRad === null ? undefined : command.angleRad,
      });
      return { accepted: true };
    }

    case 'update_route': {
      const routes = world.routesByFaction[faction];
      const idx = routes.findIndex((r) => r.id === command.routeId);
      if (idx === -1) {
        return { accepted: false, reason: `Unknown logistics route: ${command.routeId}` };
      }
      routes[idx] = {
        ...routes[idx]!,
        ...command.patch,
      };
      return { accepted: true };
    }

    case 'launch_drone': {
      return launchCarrierDrone(
        world,
        faction,
        command.unitId,
        command.droneKind,
        command.targetOrbit,
      );
    }

    case 'fire_munition': {
      const { unit, error } = getOwnedUnit(world, faction, command.unitId);
      if (!unit) {
        return { accepted: false, reason: error };
      }
      return { accepted: false, reason: `${command.type} system pending M3 integration` };
    }

    case 'queue_build': {
      return { accepted: false, reason: 'queue_build system pending M4 integration' };
    }
  }
}
