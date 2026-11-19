import {
  CELESTIAL_BODIES_BY_ID,
  LOGISTICS_CONFIG,
  PROPULSION_CONFIGS,
  UNIT_CONFIGS,
  WONDER_CONFIG,
  applyImpulsiveBurn,
  getBodyStateAt,
  orbitToState,
  solveInterceptTransfer,
  solveLambertTransfer,
  type BuildQueueKind,
  type CelestialBody,
  type FactionId,
  type KeplerOrbit,
  type LogisticsRoute,
  type ResourceType,
  type TransferBurn,
  type TransferMode,
  type UnitEntity,
  type UnitKind,
  type Vec2,
} from '@space-war/shared';
import type { CommandValidationResult } from '../engine/commandPipeline.js';
import type { TickSystemHook } from '../engine/simulationLoop.js';
import {
  createUnitEntity,
  type FreighterFlightMeta,
  type ProductionQueueItem,
  type WorldState,
} from '../engine/worldState.js';

export const LOGISTICS_CONSTANTS = {
  detourReachRadiusAu: 0.06,
  freighterArrivalRadiusAu: 0.05,
  resupplyRangeAu: 0.04,
  resupplyMaxDeltaVPerSec: 0.004,
  propellantPerDeltaV: 1500,
  miningYieldDivisor: 3.0,
  maxConcurrentProduction: 2,
  guidanceCheckIntervalSec: 5.0,
  orbitMissToleranceAu: 0.045,
} as const;

const BUILDABLE_SHIP_KINDS = new Set<UnitKind>([
  'recon_corvette',
  'escort_frigate',
  'raider',
  'cruiser',
  'tanker',
]);

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function getLivingHomeBase(world: WorldState, faction: FactionId): UnitEntity | undefined {
  const unit = world.units.get(`${faction}-home-base`);
  if (unit && unit.hp > 0 && unit.kind === 'home_base') {
    return unit;
  }
  for (const candidate of world.units.values()) {
    if (candidate.faction === faction && candidate.kind === 'home_base' && candidate.hp > 0) {
      return candidate;
    }
  }
  return undefined;
}

function getPreferredResourceForBody(body: CelestialBody): ResourceType {
  const ore = body.yields.ore ?? 0;
  const propellant = body.yields.propellant ?? 0;
  return propellant > ore ? 'propellant' : 'ore';
}

function isBodyEligibleForOutpost(
  world: WorldState,
  faction: FactionId,
  body: CelestialBody,
): { eligible: boolean; reason?: string } {
  if (!body.orbit || body.id === 'sun') {
    return { eligible: false, reason: 'Cannot build mining outpost on the Sun' };
  }
  if (body.ownerSlot !== undefined) {
    return {
      eligible: false,
      reason: `Geographical tier rule forbids mining outposts on home planet ${body.name}`,
    };
  }
  const hasYield = (body.yields.ore ?? 0) > 0 || (body.yields.propellant ?? 0) > 0;
  if (!hasYield) {
    return { eligible: false, reason: `${body.name} has no extractable resources` };
  }

  for (const [unitId, bodyId] of world.outpostBodyByUnitId.entries()) {
    const unit = world.units.get(unitId);
    if (unit && unit.faction === faction && unit.hp > 0 && bodyId === body.id) {
      return { eligible: false, reason: `${faction} already operates an outpost on ${body.name}` };
    }
  }
  for (const queued of world.productionQueueByFaction[faction]) {
    if (queued.kind === 'outpost' && queued.targetBodyId === body.id) {
      return { eligible: false, reason: `Outpost on ${body.name} is already queued` };
    }
  }
  return { eligible: true };
}

function findNearestEligibleOutpostBody(
  world: WorldState,
  faction: FactionId,
  homePos: Vec2,
): CelestialBody | null {
  let best: CelestialBody | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const body of world.celestials) {
    if (!isBodyEligibleForOutpost(world, faction, body).eligible) {
      continue;
    }
    const pos = getBodyStateAt(body, world.gameTimeSec).pos;
    const dist = Math.hypot(pos.x - homePos.x, pos.y - homePos.y);
    if (dist < bestDist) {
      bestDist = dist;
      best = body;
    }
  }
  return best;
}

/**
 * Validates geographical industrial-tier rules and enqueues a home-base build,
 * capacity expansion, outpost kit, deep-space relay depot, or wonder slot action.
 */
export function enqueueFactionBuild(
  world: WorldState,
  faction: FactionId,
  kind: BuildQueueKind,
  targetRef?: string | Vec2,
): CommandValidationResult & { itemId?: string } {
  const homeBase = getLivingHomeBase(world, faction);
  if (!homeBase) {
    return { accepted: false, reason: 'Home base is destroyed' };
  }

  const factionState = world.factions[faction];
  const queue = world.productionQueueByFaction[faction];

  const allocateQueueId = (): string => {
    const seq = world.nextBuildSeqByFaction[faction];
    world.nextBuildSeqByFaction[faction] = seq + 1;
    return `bld-${faction}-${seq}`;
  };

  if (kind === 'outpost') {
    if (typeof targetRef === 'object' && targetRef !== null) {
      return {
        accepted: false,
        reason: 'Mining outposts must be built on a resource celestial body, not in deep space',
      };
    }

    let body: CelestialBody | undefined;
    if (typeof targetRef === 'string') {
      if (world.units.has(targetRef)) {
        return {
          accepted: false,
          reason: `Cannot build mining outpost on unit/station ${targetRef}`,
        };
      }
      body = world.celestials.find((b) => b.id === targetRef);
      if (!body) {
        return { accepted: false, reason: `Unknown celestial body: ${targetRef}` };
      }
      const check = isBodyEligibleForOutpost(world, faction, body);
      if (!check.eligible) {
        return { accepted: false, reason: check.reason };
      }
    } else {
      body = findNearestEligibleOutpostBody(world, faction, homeBase.pos) ?? undefined;
      if (!body) {
        return { accepted: false, reason: 'No eligible unclaimed resource bodies available' };
      }
    }

    const cfg = UNIT_CONFIGS.mining_outpost;
    if (
      factionState.resources.ore < cfg.costOre ||
      factionState.resources.propellant < cfg.costPropellant
    ) {
      return { accepted: false, reason: 'Insufficient resources for mining outpost' };
    }

    factionState.resources.ore -= cfg.costOre;
    factionState.resources.propellant -= cfg.costPropellant;

    const item: ProductionQueueItem = {
      id: allocateQueueId(),
      kind: 'outpost',
      remainingSec: cfg.buildTimeSec,
      totalSec: cfg.buildTimeSec,
      targetBodyId: body.id,
      targetRef: body.id,
    };
    queue.push(item);
    return { accepted: true, itemId: item.id };
  }

  if (kind === 'relay_depot') {
    if (typeof targetRef === 'string') {
      return {
        accepted: false,
        reason: 'Relay depots must be deployed to deep-space coordinates, not a celestial body',
      };
    }

    let deployPos: Vec2;
    if (typeof targetRef === 'object' && targetRef !== null) {
      if (!Number.isFinite(targetRef.x) || !Number.isFinite(targetRef.y)) {
        return { accepted: false, reason: 'Invalid relay depot coordinates' };
      }
      deployPos = { x: targetRef.x, y: targetRef.y };
    } else {
      const homeAngle = Math.atan2(homeBase.pos.y, homeBase.pos.x);
      const radius = faction === 'earth' ? 1.22 : 1.38;
      deployPos = {
        x: Math.cos(homeAngle) * radius,
        y: Math.sin(homeAngle) * radius,
      };
    }

    const heliocentricR = Math.hypot(deployPos.x, deployPos.y);
    if (heliocentricR < 0.25 || heliocentricR > 3.6) {
      return { accepted: false, reason: 'Relay depot orbit radius must be within 0.25 - 3.6 AU' };
    }

    for (const body of world.celestials) {
      const bodyPos = getBodyStateAt(body, world.gameTimeSec).pos;
      const dist = Math.hypot(deployPos.x - bodyPos.x, deployPos.y - bodyPos.y);
      if (dist < body.occlusionRadiusAu * 1.4) {
        return {
          accepted: false,
          reason: `Relay depot too close to celestial body ${body.name}`,
        };
      }
    }

    const cfg = UNIT_CONFIGS.relay_depot;
    if (
      factionState.resources.ore < cfg.costOre ||
      factionState.resources.propellant < cfg.costPropellant
    ) {
      return { accepted: false, reason: 'Insufficient resources for relay depot' };
    }

    factionState.resources.ore -= cfg.costOre;
    factionState.resources.propellant -= cfg.costPropellant;

    const item: ProductionQueueItem = {
      id: allocateQueueId(),
      kind: 'relay_depot',
      remainingSec: cfg.buildTimeSec,
      totalSec: cfg.buildTimeSec,
      targetRef: deployPos,
    };
    queue.push(item);
    return { accepted: true, itemId: item.id };
  }

  if (kind === 'freighter_cap') {
    if (typeof targetRef === 'object' && targetRef !== null) {
      return { accepted: false, reason: 'Freighter capacity can only be expanded at home base' };
    }
    if (typeof targetRef === 'string' && targetRef !== homeBase.id) {
      return {
        accepted: false,
        reason: `Geographical tier rule forbids expanding freighter capacity at ${targetRef}`,
      };
    }
    if (factionState.resources.ore < LOGISTICS_CONFIG.freighterCapCostOre) {
      return { accepted: false, reason: 'Insufficient Ore for freighter capacity' };
    }

    factionState.resources.ore -= LOGISTICS_CONFIG.freighterCapCostOre;
    const item: ProductionQueueItem = {
      id: allocateQueueId(),
      kind: 'freighter_cap',
      remainingSec: LOGISTICS_CONFIG.freighterCapBuildTimeSec,
      totalSec: LOGISTICS_CONFIG.freighterCapBuildTimeSec,
    };
    queue.push(item);
    return { accepted: true, itemId: item.id };
  }

  if (kind === 'wonder_slot') {
    let explicitIndex: number | undefined;
    if (typeof targetRef === 'object' && targetRef !== null) {
      return { accepted: false, reason: 'Wonder slots must be constructed at home-base co-orbital ring' };
    }
    if (typeof targetRef === 'string') {
      if (targetRef !== homeBase.id) {
        const parsed = Number(targetRef.replace(/^slot-/, ''));
        if (!Number.isInteger(parsed) || parsed < 0 || parsed >= WONDER_CONFIG.slotCount) {
          return {
            accepted: false,
            reason: `Invalid wonder slot or off-world builder reference: ${targetRef}`,
          };
        }
        explicitIndex = parsed;
      }
    }

    const wonder = factionState.wonder;

    // Repair damaged_halted slots first
    const damagedSlot =
      explicitIndex !== undefined
        ? wonder[explicitIndex]?.status === 'damaged_halted'
          ? wonder[explicitIndex]
          : undefined
        : wonder.find((s) => s.status === 'damaged_halted');

    if (damagedSlot) {
      const repairCost = Math.round(WONDER_CONFIG.orePerSlot * WONDER_CONFIG.repairOreRatio);
      if (factionState.resources.ore < repairCost) {
        return { accepted: false, reason: 'Insufficient Ore to repair halted wonder slot' };
      }
      factionState.resources.ore -= repairCost;
      damagedSlot.hp = damagedSlot.maxHp;
      damagedSlot.status =
        damagedSlot.progressOre >= damagedSlot.requiredOre ? 'complete' : 'building';
      return { accepted: true };
    }

    const activeBuildingCount = wonder.filter((s) => s.status === 'building').length;
    if (activeBuildingCount >= WONDER_CONFIG.maxConcurrentSlots) {
      return {
        accepted: false,
        reason: `Maximum concurrent wonder slots (${WONDER_CONFIG.maxConcurrentSlots}) already building`,
      };
    }

    const targetSlot =
      explicitIndex !== undefined ? wonder[explicitIndex] : wonder.find((s) => s.status === 'empty');
    if (!targetSlot || targetSlot.status !== 'empty') {
      return { accepted: false, reason: 'No empty wonder slots remaining' };
    }

    if (factionState.resources.ore < WONDER_CONFIG.orePerSlot) {
      return { accepted: false, reason: 'Insufficient Ore for wonder slot' };
    }

    factionState.resources.ore -= WONDER_CONFIG.orePerSlot;
    targetSlot.status = 'building';
    return { accepted: true };
  }

  // Shipbuilding: strictly restricted to home_base
  if (typeof targetRef === 'object' && targetRef !== null) {
    return {
      accepted: false,
      reason: 'Geographical tier rule forbids building warships in deep space',
    };
  }
  if (typeof targetRef === 'string' && targetRef !== homeBase.id) {
    return {
      accepted: false,
      reason: `Geographical tier rule forbids building ${kind} outside home base (${targetRef})`,
    };
  }

  if (!BUILDABLE_SHIP_KINDS.has(kind as UnitKind)) {
    return { accepted: false, reason: `Unit kind ${kind} cannot be queued for construction` };
  }

  const shipKind = kind as UnitKind;
  const cfg = UNIT_CONFIGS[shipKind];
  if (
    factionState.resources.ore < cfg.costOre ||
    factionState.resources.propellant < cfg.costPropellant
  ) {
    return { accepted: false, reason: `Insufficient resources to build ${cfg.name}` };
  }

  factionState.resources.ore -= cfg.costOre;
  factionState.resources.propellant -= cfg.costPropellant;

  const item: ProductionQueueItem = {
    id: allocateQueueId(),
    kind: shipKind,
    remainingSec: cfg.buildTimeSec,
    totalSec: cfg.buildTimeSec,
  };
  queue.push(item);
  return { accepted: true, itemId: item.id };
}

/**
 * Computes the world position of one of the 16 co-orbital wonder slots around a faction's
 * home planet orbit (matching client-side `computeCoOrbitalWonderNodes`).
 */
export function getWonderSlotPosition(
  world: WorldState,
  faction: FactionId,
  slotIndex: number,
): Vec2 {
  const homeBody = world.celestials.find((b) => b.id === faction) ?? CELESTIAL_BODIES_BY_ID[faction];
  const baseOrbit: KeplerOrbit = homeBody?.orbit ?? {
    a: WONDER_CONFIG.ringSemiMajorAxisAu[faction],
    e: 0,
    omega: 0,
    meanAnomaly0: 0,
    epochSec: 0,
  };

  const count = WONDER_CONFIG.slotCount;
  const pitch = (2 * Math.PI) / count;
  const phaseOffset = pitch * 0.5;
  const slotOrbit: KeplerOrbit = {
    ...baseOrbit,
    meanAnomaly0: baseOrbit.meanAnomaly0 + phaseOffset + slotIndex * pitch,
  };
  return orbitToState(slotOrbit, world.gameTimeSec).pos;
}

/**
 * Applies enemy attack damage to one of a faction's 16 co-orbital wonder slots.
 * Wonder slots are extremely resilient and transition into `'damaged_halted'` rather than disappearing.
 */
export function damageWonderSlot(
  world: WorldState,
  faction: FactionId,
  slotIndex: number,
  damage: number,
): boolean {
  if (damage <= 0 || slotIndex < 0 || slotIndex >= WONDER_CONFIG.slotCount) {
    return false;
  }
  const slot = world.factions[faction].wonder[slotIndex];
  if (!slot || slot.status === 'empty') {
    return false;
  }

  slot.hp = Math.max(1, slot.hp - damage);
  slot.status = 'damaged_halted';
  world.wonderStabilizedSecByFaction[faction] = 0;
  world.vfxEvents.push({
    kind: 'explosion',
    from: getWonderSlotPosition(world, faction, slotIndex),
    intensity: 0.9,
  });
  return true;
}

/**
 * Permanently deducts 1 point of `freighterCap` and releases in-flight count when
 * a pooled freighter is destroyed in transit.
 */
export function handleFreighterDestroyed(world: WorldState, freighter: UnitEntity): void {
  if (freighter.kind !== 'freighter') {
    return;
  }
  const meta = world.freighterMeta.get(freighter.id);
  if (meta?.penaltyApplied) {
    return;
  }
  if (meta) {
    meta.penaltyApplied = true;
  }

  const factionState = world.factions[freighter.faction];
  factionState.freightersInFlight = Math.max(0, factionState.freightersInFlight - 1);
  factionState.freighterCap = Math.max(0, factionState.freighterCap - 1);

  world.units.delete(freighter.id);
  world.freighterMeta.delete(freighter.id);
}

function planBurnsToTarget(
  ship: UnitEntity,
  targetPos: Vec2,
  targetOrbit: KeplerOrbit | null,
  nowSec: number,
  mode: TransferMode,
): TransferBurn[] {
  if (ship.subsystems.propulsion === 'offline' || ship.deltaV <= 1e-6) {
    return [];
  }

  const candDts =
    mode === 'fast'
      ? [10, 16, 24, 34, 48, 66, 90, 120]
      : mode === 'stealth'
        ? [28, 45, 70, 98, 128, 160, 190]
        : [12, 20, 30, 44, 64, 88, 115, 145, 175];

  let bestUnderCap: { dv: Vec2; mag: number; dt: number } | null = null;
  let bestAny: { dv: Vec2; mag: number; dt: number } | null = null;

  for (const dt of candDts) {
    const arrPos = targetOrbit ? orbitToState(targetOrbit, nowSec + dt).pos : targetPos;
    const lambert = solveLambertTransfer(ship.pos, arrPos, dt, nowSec);
    if (!lambert) {
      continue;
    }
    const dv: Vec2 = {
      x: lambert.v1.x - ship.vel.x,
      y: lambert.v1.y - ship.vel.y,
    };
    const mag = Math.hypot(dv.x, dv.y);

    if (!bestAny || mag < bestAny.mag) {
      bestAny = { dv, mag, dt };
    }
    if (mag <= ship.deltaV * 0.92) {
      if (mode === 'fast') {
        bestUnderCap = { dv, mag, dt };
        break;
      }
      if (!bestUnderCap || mag < bestUnderCap.mag) {
        bestUnderCap = { dv, mag, dt };
      }
    }
  }

  let chosenDv: Vec2 | null = bestUnderCap?.dv ?? null;
  if (!chosenDv && bestAny) {
    const scale = (ship.deltaV * 0.85) / Math.max(1e-9, bestAny.mag);
    chosenDv = { x: bestAny.dv.x * scale, y: bestAny.dv.y * scale };
  }

  if (!chosenDv) {
    const dist = Math.hypot(targetPos.x - ship.pos.x, targetPos.y - ship.pos.y);
    const estDt = clamp(dist / 0.012, 5, 75);
    const arrPos = targetOrbit ? orbitToState(targetOrbit, nowSec + estDt).pos : targetPos;
    const coastPos = orbitToState(ship.orbit, nowSec + estDt).pos;
    const gapX = arrPos.x - coastPos.x;
    const gapY = arrPos.y - coastPos.y;
    const gapLen = Math.hypot(gapX, gapY);
    if (gapLen > 1e-9) {
      const mag = clamp(gapLen / estDt, 0.0006, ship.deltaV * 0.45);
      chosenDv = {
        x: (gapX / gapLen) * mag,
        y: (gapY / gapLen) * mag,
      };
    }
  }

  if (!chosenDv) {
    return [];
  }

  const dvMag = Math.hypot(chosenDv.x, chosenDv.y);
  if (dvMag <= 1e-7) {
    return [];
  }

  const durationSec =
    ship.propulsion === 'electric'
      ? clamp(Math.ceil(dvMag / PROPULSION_CONFIGS.electric.maxAccelAuPerSec2), 6, 40)
      : 0;

  return [
    {
      executeAtSec: nowSec,
      deltaV: chosenDv,
      durationSec,
      isOccludedStart: false,
    },
  ];
}

function willOrbitReachTarget(
  shipOrbit: KeplerOrbit,
  targetPos: Vec2,
  targetOrbit: KeplerOrbit | null,
  nowSec: number,
  toleranceAu: number,
  horizonSec = 190,
): boolean {
  for (let dt = 5; dt <= horizonSec; dt += 5) {
    const pShip = orbitToState(shipOrbit, nowSec + dt).pos;
    const pTarget = targetOrbit ? orbitToState(targetOrbit, nowSec + dt).pos : targetPos;
    if (Math.hypot(pShip.x - pTarget.x, pShip.y - pTarget.y) <= toleranceAu) {
      return true;
    }
  }
  return false;
}

function steerUnitImmediately(
  ship: UnitEntity,
  burns: TransferBurn[],
  nowSec: number,
): UnitEntity {
  if (burns.length === 0) {
    return ship;
  }
  const first = burns[0]!;
  if (ship.propulsion === 'chemical' && first.durationSec <= 0) {
    const applied = applyImpulsiveBurn(
      { pos: ship.pos, vel: ship.vel },
      first.deltaV,
      ship.deltaV,
      nowSec,
      ship.subsystems.propulsion,
    );
    return {
      ...ship,
      pos: applied.state.pos,
      vel: applied.state.vel,
      orbit: applied.orbit,
      deltaV: applied.remainingDeltaV,
      plannedBurns: burns.slice(1),
    };
  }
  return {
    ...ship,
    plannedBurns: burns,
  };
}

function assignEscortsForConvoy(
  world: WorldState,
  route: LogisticsRoute,
  leadFreighter: UnitEntity,
  targetUnit: UnitEntity,
): void {
  for (const escortId of route.escortUnitIds) {
    const escort = world.units.get(escortId);
    if (
      !escort ||
      escort.faction !== route.faction ||
      escort.hp <= 0 ||
      escort.subsystems.propulsion === 'offline' ||
      escort.deltaV <= 0
    ) {
      continue;
    }

    if (route.detourWaypoint) {
      const burns = planBurnsToTarget(
        escort,
        route.detourWaypoint,
        null,
        world.gameTimeSec,
        route.transferMode,
      );
      world.units.set(escort.id, { ...escort, plannedBurns: burns });
    } else {
      const plan = solveInterceptTransfer(
        {
          unit: escort,
          nowSec: world.gameTimeSec,
          celestialBodies: world.celestials,
        },
        leadFreighter,
      );
      const chosen = plan[route.transferMode].feasible
        ? plan[route.transferMode]
        : plan.fuel.feasible
          ? plan.fuel
          : plan.fast;
      if (chosen.feasible && chosen.burns.length > 0) {
        world.units.set(escort.id, {
          ...escort,
          plannedBurns: chosen.burns.map((b) => ({ ...b, deltaV: { ...b.deltaV } })),
        });
      } else {
        const burns = planBurnsToTarget(
          escort,
          targetUnit.pos,
          targetUnit.orbit,
          world.gameTimeSec,
          route.transferMode,
        );
        world.units.set(escort.id, { ...escort, plannedBurns: burns });
      }
    }
  }
}

function stepMiningOutposts(world: WorldState, dtSec: number): void {
  for (const [unitId, bodyId] of world.outpostBodyByUnitId.entries()) {
    const outpost = world.units.get(unitId);
    if (!outpost || outpost.hp <= 0) {
      continue;
    }
    const body = world.celestials.find((b) => b.id === bodyId);
    if (!body || !body.orbit) {
      continue;
    }

    const bodyState = getBodyStateAt(body, world.gameTimeSec);
    const cargo: Partial<Record<ResourceType, number>> = { ...(outpost.cargo ?? {}) };
    const maxCap = UNIT_CONFIGS.mining_outpost.logistics.cargoCapacity;
    const baseRate = UNIT_CONFIGS.mining_outpost.logistics.miningRatePerSec;

    for (const res of ['ore', 'propellant'] as const) {
      const yieldVal = body.yields[res] ?? 0;
      if (yieldVal > 0) {
        const current = cargo[res] ?? 0;
        const delta = (baseRate * (yieldVal / LOGISTICS_CONSTANTS.miningYieldDivisor)) * dtSec;
        cargo[res] = Math.min(maxCap, current + delta);
      }
    }

    world.units.set(unitId, {
      ...outpost,
      pos: bodyState.pos,
      vel: bodyState.vel,
      orbit: { ...body.orbit },
      cargo,
    });
  }
}

function findOutpostForBody(
  world: WorldState,
  faction: FactionId,
  bodyId: string,
): UnitEntity | undefined {
  for (const [unitId, bId] of world.outpostBodyByUnitId.entries()) {
    if (bId !== bodyId) {
      continue;
    }
    const unit = world.units.get(unitId);
    if (unit && unit.faction === faction && unit.hp > 0) {
      return unit;
    }
  }
  return undefined;
}

function stepRouteDispatch(world: WorldState): void {
  for (const faction of ['earth', 'mars'] as const) {
    const factionState = world.factions[faction];
    const routes = world.routesByFaction[faction];

    for (const route of routes) {
      if (route.paused) {
        continue;
      }

      const batchSize = clamp(
        Math.round(route.batchSize),
        LOGISTICS_CONFIG.minBatchSize,
        LOGISTICS_CONFIG.maxBatchSize,
      );
      if (factionState.freightersInFlight + batchSize > factionState.freighterCap) {
        continue;
      }

      const outpost = findOutpostForBody(world, faction, route.sourceBodyId);
      const targetUnit = world.units.get(route.targetId);
      if (!outpost || outpost.hp <= 0 || !targetUnit || targetUnit.hp <= 0) {
        continue;
      }

      const neededCargo = batchSize * LOGISTICS_CONFIG.freighterBatchCargo;
      const available = outpost.cargo?.[route.resource] ?? 0;
      if (available < neededCargo) {
        continue;
      }

      const updatedCargo = { ...(outpost.cargo ?? {}) };
      updatedCargo[route.resource] = available - neededCargo;
      world.units.set(outpost.id, { ...outpost, cargo: updatedCargo });

      let leadFreighter: UnitEntity | null = null;
      const propulsion = route.transferMode === 'stealth' ? 'electric' : 'chemical';

      for (let i = 0; i < batchSize; i++) {
        const seq = world.nextFreighterSeqByFaction[faction];
        world.nextFreighterSeqByFaction[faction] = seq + 1;
        const freighterId = `frt-${faction}-${seq}`;

        const spawnOrbit: KeplerOrbit = {
          ...outpost.orbit,
          meanAnomaly0: outpost.orbit.meanAnomaly0 + i * 0.0015,
        };
        let freighter = createUnitEntity({
          id: freighterId,
          faction,
          kind: 'freighter',
          orbit: spawnOrbit,
          gameTimeSec: world.gameTimeSec,
          propulsion,
          emconSilent: route.transferMode === 'stealth',
          cargo: { [route.resource]: LOGISTICS_CONFIG.freighterBatchCargo },
        });

        const meta: FreighterFlightMeta = {
          routeId: route.id,
          sourceBodyId: route.sourceBodyId,
          targetId: route.targetId,
          resource: route.resource,
          amount: LOGISTICS_CONFIG.freighterBatchCargo,
          transferMode: route.transferMode,
          ...(route.detourWaypoint ? { detourWaypoint: { ...route.detourWaypoint } } : {}),
          detourReached: false,
          lastGuidedSec: world.gameTimeSec,
        };

        const firstTargetPos = meta.detourWaypoint ?? targetUnit.pos;
        const firstTargetOrbit = meta.detourWaypoint ? null : targetUnit.orbit;
        const burns = planBurnsToTarget(
          freighter,
          firstTargetPos,
          firstTargetOrbit,
          world.gameTimeSec,
          route.transferMode,
        );
        freighter = steerUnitImmediately(freighter, burns, world.gameTimeSec);

        world.units.set(freighter.id, freighter);
        world.freighterMeta.set(freighter.id, meta);
        factionState.freightersInFlight += 1;

        if (!leadFreighter) {
          leadFreighter = freighter;
        }
      }

      if (leadFreighter && route.escortUnitIds.length > 0) {
        assignEscortsForConvoy(world, route, leadFreighter, targetUnit);
      }
    }
  }
}

function stepFreightersInFlight(world: WorldState): void {
  for (const [unitId, meta] of [...world.freighterMeta.entries()]) {
    const freighter = world.units.get(unitId);
    if (!freighter || freighter.hp <= 0) {
      if (freighter) {
        handleFreighterDestroyed(world, freighter);
      } else {
        const factionState = world.factions[unitId.startsWith('frt-mars-') ? 'mars' : 'earth'];
        if (!meta.penaltyApplied) {
          meta.penaltyApplied = true;
          factionState.freightersInFlight = Math.max(0, factionState.freightersInFlight - 1);
          factionState.freighterCap = Math.max(0, factionState.freighterCap - 1);
        }
        world.freighterMeta.delete(unitId);
      }
      continue;
    }

    let targetUnit = world.units.get(meta.targetId);
    if (!targetUnit || targetUnit.hp <= 0) {
      targetUnit = getLivingHomeBase(world, freighter.faction);
      if (!targetUnit) {
        continue;
      }
      meta.targetId = targetUnit.id;
    }

    // Check detour waypoint progression
    if (meta.detourWaypoint && !meta.detourReached) {
      const distDetour = Math.hypot(
        freighter.pos.x - meta.detourWaypoint.x,
        freighter.pos.y - meta.detourWaypoint.y,
      );
      if (distDetour <= LOGISTICS_CONSTANTS.detourReachRadiusAu) {
        meta.detourReached = true;
        const leg2Burns = planBurnsToTarget(
          freighter,
          targetUnit.pos,
          targetUnit.orbit,
          world.gameTimeSec,
          meta.transferMode,
        );
        const updated = steerUnitImmediately(freighter, leg2Burns, world.gameTimeSec);
        meta.lastGuidedSec = world.gameTimeSec;
        world.units.set(freighter.id, updated);

        // Also update bound escorts if idle near detour
        const route = world.routesByFaction[freighter.faction].find((r) => r.id === meta.routeId);
        if (route) {
          for (const escortId of route.escortUnitIds) {
            const escort = world.units.get(escortId);
            if (
              escort &&
              escort.faction === freighter.faction &&
              escort.hp > 0 &&
              escort.plannedBurns.length === 0
            ) {
              const escortBurns = planBurnsToTarget(
                escort,
                targetUnit.pos,
                targetUnit.orbit,
                world.gameTimeSec,
                route.transferMode,
              );
              world.units.set(escort.id, { ...escort, plannedBurns: escortBurns });
            }
          }
        }
        continue;
      }
    }

    // Check arrival at destination (only after clearing detour if one was configured)
    const detourSatisfied = !meta.detourWaypoint || meta.detourReached;
    const distTarget = Math.hypot(
      freighter.pos.x - targetUnit.pos.x,
      freighter.pos.y - targetUnit.pos.y,
    );
    if (detourSatisfied && distTarget <= LOGISTICS_CONSTANTS.freighterArrivalRadiusAu) {
      const factionState = world.factions[freighter.faction];
      factionState.resources[meta.resource] += meta.amount;
      factionState.freightersInFlight = Math.max(0, factionState.freightersInFlight - 1);
      world.units.delete(freighter.id);
      world.freighterMeta.delete(freighter.id);
      continue;
    }

    // Periodic mid-course orbit guidance if drifting off-course
    const lastCheck = meta.lastGuidedSec ?? -999;
    if (
      freighter.plannedBurns.length === 0 &&
      freighter.deltaV > 1e-6 &&
      freighter.subsystems.propulsion !== 'offline' &&
      world.gameTimeSec - lastCheck >= LOGISTICS_CONSTANTS.guidanceCheckIntervalSec
    ) {
      meta.lastGuidedSec = world.gameTimeSec;
      const activePos = !detourSatisfied && meta.detourWaypoint ? meta.detourWaypoint : targetUnit.pos;
      const activeOrbit = !detourSatisfied && meta.detourWaypoint ? null : targetUnit.orbit;
      const tol = !detourSatisfied
        ? LOGISTICS_CONSTANTS.detourReachRadiusAu * 0.9
        : LOGISTICS_CONSTANTS.orbitMissToleranceAu;

      if (!willOrbitReachTarget(freighter.orbit, activePos, activeOrbit, world.gameTimeSec, tol)) {
        const trimBurns = planBurnsToTarget(
          freighter,
          activePos,
          activeOrbit,
          world.gameTimeSec,
          meta.transferMode,
        );
        const updated = steerUnitImmediately(freighter, trimBurns, world.gameTimeSec);
        world.units.set(freighter.id, updated);
      }
    }
  }
}

function stepFieldResupply(world: WorldState, dtSec: number): void {
  const suppliers: UnitEntity[] = [];
  for (const unit of world.units.values()) {
    if (unit.hp > 0 && UNIT_CONFIGS[unit.kind].logistics.canResupply) {
      suppliers.push(unit);
    }
  }

  for (const supplier of suppliers) {
    const factionState = world.factions[supplier.faction];
    for (const [allyId, ally] of world.units.entries()) {
      if (
        allyId === supplier.id ||
        ally.faction !== supplier.faction ||
        ally.hp <= 0 ||
        ally.kind === 'home_base' ||
        ally.kind === 'mining_outpost' ||
        ally.kind === 'relay_depot' ||
        ally.deltaV >= ally.maxDeltaV - 1e-9
      ) {
        continue;
      }

      const dist = Math.hypot(ally.pos.x - supplier.pos.x, ally.pos.y - supplier.pos.y);
      if (dist > LOGISTICS_CONSTANTS.resupplyRangeAu) {
        continue;
      }

      const dvNeed = ally.maxDeltaV - ally.deltaV;
      const maxTransfer = Math.min(dvNeed, LOGISTICS_CONSTANTS.resupplyMaxDeltaVPerSec * dtSec);
      const propNeeded = maxTransfer * LOGISTICS_CONSTANTS.propellantPerDeltaV;

      let dvGranted = 0;
      if (factionState.resources.propellant > 1e-6) {
        const propSpent = Math.min(factionState.resources.propellant, propNeeded);
        factionState.resources.propellant -= propSpent;
        dvGranted = maxTransfer * (propSpent / Math.max(1e-9, propNeeded));
      } else if (supplier.kind === 'tanker' && supplier.deltaV > 0.002) {
        // Emergency ship-to-ship transfer from tanker's own reserve
        const latestSupplier = world.units.get(supplier.id) ?? supplier;
        dvGranted = Math.min(maxTransfer, Math.max(0, latestSupplier.deltaV - 0.002));
        world.units.set(latestSupplier.id, {
          ...latestSupplier,
          deltaV: latestSupplier.deltaV - dvGranted,
        });
      }

      if (dvGranted > 0) {
        world.units.set(allyId, {
          ...ally,
          deltaV: Math.min(ally.maxDeltaV, ally.deltaV + dvGranted),
        });
      }
    }
  }
}

function completeBuildItem(
  world: WorldState,
  faction: FactionId,
  item: ProductionQueueItem,
): void {
  const factionState = world.factions[faction];
  const homeBase = getLivingHomeBase(world, faction);
  if (!homeBase) {
    return;
  }

  if (item.kind === 'freighter_cap') {
    factionState.freighterCap += 1;
    return;
  }

  if (item.kind === 'outpost' && item.targetBodyId) {
    const body = world.celestials.find((b) => b.id === item.targetBodyId);
    if (!body || !body.orbit) {
      return;
    }
    const seq = world.nextFacilitySeqByFaction[faction];
    world.nextFacilitySeqByFaction[faction] = seq + 1;
    const outpostId = `${faction}-outpost-${body.id}-${seq}`;
    const outpost = createUnitEntity({
      id: outpostId,
      faction,
      kind: 'mining_outpost',
      orbit: body.orbit,
      gameTimeSec: world.gameTimeSec,
      cargo: { ore: 0, propellant: 0 },
    });
    world.units.set(outpost.id, outpost);
    world.outpostBodyByUnitId.set(outpost.id, body.id);

    const hasRoute = world.routesByFaction[faction].some((r) => r.sourceBodyId === body.id);
    if (!hasRoute) {
      world.routesByFaction[faction].push({
        id: `route-${faction}-${body.id}-${seq}`,
        faction,
        sourceBodyId: body.id,
        targetId: homeBase.id,
        resource: getPreferredResourceForBody(body),
        paused: false,
        batchSize: 1,
        transferMode: 'fuel',
        escortUnitIds: [],
      });
    }
    return;
  }

  if (item.kind === 'relay_depot') {
    const deployPos =
      typeof item.targetRef === 'object' && item.targetRef !== null
        ? item.targetRef
        : { x: homeBase.pos.x * 1.15, y: homeBase.pos.y * 1.15 };
    const r = Math.max(0.25, Math.hypot(deployPos.x, deployPos.y));
    const angle = Math.atan2(deployPos.y, deployPos.x);
    const seq = world.nextFacilitySeqByFaction[faction];
    world.nextFacilitySeqByFaction[faction] = seq + 1;
    const depotId = `${faction}-relay-${seq}`;
    const depot = createUnitEntity({
      id: depotId,
      faction,
      kind: 'relay_depot',
      orbit: {
        a: r,
        e: 0,
        omega: 0,
        meanAnomaly0: angle,
        epochSec: world.gameTimeSec,
      },
      gameTimeSec: world.gameTimeSec,
      cargo: {},
    });
    world.units.set(depot.id, depot);
    return;
  }

  if (BUILDABLE_SHIP_KINDS.has(item.kind as UnitKind)) {
    const shipKind = item.kind as UnitKind;
    const seq = world.nextFacilitySeqByFaction[faction];
    world.nextFacilitySeqByFaction[faction] = seq + 1;
    const shipId = `${faction}-${shipKind}-${seq}`;
    const spawnOrbit: KeplerOrbit = {
      ...homeBase.orbit,
      a: homeBase.orbit.a + 0.025,
      meanAnomaly0: homeBase.orbit.meanAnomaly0 + 0.02 * (seq % 8),
    };
    const ship = createUnitEntity({
      id: shipId,
      faction,
      kind: shipKind,
      orbit: spawnOrbit,
      gameTimeSec: world.gameTimeSec,
      emconSilent: shipKind === 'raider',
    });
    world.units.set(ship.id, ship);
  }
}

function stepProductionAndWonder(world: WorldState, dtSec: number): void {
  for (const faction of ['earth', 'mars'] as const) {
    const homeBase = getLivingHomeBase(world, faction);
    if (!homeBase) {
      continue;
    }

    // Advance home-base production queue
    const queue = world.productionQueueByFaction[faction];
    const activeCount = Math.min(LOGISTICS_CONSTANTS.maxConcurrentProduction, queue.length);
    const completedIds = new Set<string>();
    for (let i = 0; i < activeCount; i++) {
      const item = queue[i]!;
      item.remainingSec -= dtSec;
      if (item.remainingSec <= 0) {
        completeBuildItem(world, faction, item);
        completedIds.add(item.id);
      }
    }
    if (completedIds.size > 0) {
      world.productionQueueByFaction[faction] = queue.filter((q) => !completedIds.has(q.id));
    }

    // Advance 16-slot co-orbital wonder construction and check victory stabilization
    const wonder = world.factions[faction].wonder;
    const oreRatePerSec = WONDER_CONFIG.orePerSlot / WONDER_CONFIG.buildTimePerSlotSec;
    for (const slot of wonder) {
      if (slot.status !== 'building') {
        continue;
      }
      slot.progressOre = Math.min(slot.requiredOre, slot.progressOre + oreRatePerSec * dtSec);
      if (slot.progressOre >= slot.requiredOre) {
        slot.status = 'complete';
      }
    }

    const allComplete =
      wonder.length === WONDER_CONFIG.slotCount && wonder.every((s) => s.status === 'complete');
    if (allComplete) {
      world.wonderStabilizedSecByFaction[faction] += dtSec;
      if (
        world.wonderStabilizedSecByFaction[faction] >= WONDER_CONFIG.stabilizationHoldSec &&
        world.winner === null
      ) {
        world.winner = faction;
      }
    } else {
      world.wonderStabilizedSecByFaction[faction] = 0;
    }
  }
}

/**
 * Advances celestial mining, pooled automatic freighter dispatch/guidance/arrival,
 * tanker & depot delta-v resupply, home-base production queues, and 16-slot wonder progress.
 */
export function stepLogisticsSystem(world: WorldState, dtSec: number): void {
  if (dtSec <= 0) {
    return;
  }
  stepMiningOutposts(world, dtSec);
  stepRouteDispatch(world);
  stepFreightersInFlight(world);
  stepFieldResupply(world, dtSec);
  stepProductionAndWonder(world, dtSec);
}

/**
 * Creates a SimulationLoop system hook executing logistics, production, and wonder systems
 * in the `post_sensor` phase.
 */
export function createLogisticsTickSystem(): TickSystemHook {
  return ({ world, dtSec }) => {
    stepLogisticsSystem(world, dtSec);
  };
}
