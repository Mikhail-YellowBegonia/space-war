import {
  CELESTIAL_BODIES_BY_ID,
  LOGISTICS_CONFIG,
  SOLAR_SYSTEM_BODIES,
  UNIT_CONFIGS,
  WONDER_CONFIG,
  getBodyStateAt,
  orbitToState,
  type CelestialBody,
  type FactionId,
  type FactionSnapshot,
  type KeplerOrbit,
  type LogisticsRoute,
  type MunitionEntity,
  type PropulsionType,
  type ResourceType,
  type SensorTrack,
  type SuspectedTrackKind,
  type TrackConfidence,
  type UnitEntity,
  type UnitKind,
  type Vec2,
  type VfxEvent,
  type WonderSlot,
} from '@space-war/shared';

export interface InternalTrackRecord {
  trackId: string;
  targetId: string;
  confidence: TrackConfidence;
  suspectedKind: SuspectedTrackKind;
  bearingRad?: number;
  originPos?: Vec2;
  pos?: Vec2;
  vel?: Vec2;
  errorRadiusMajorAu?: number;
  errorRadiusMinorAu?: number;
  errorAngleRad?: number;
  lastConfirmedOrbit?: KeplerOrbit;
  lastObservedSec: number;
  isJammed: boolean;
}

export interface MunitionRuntimeMeta {
  launchedAtSec: number;
  maxFlightSec: number;
  hp: number;
  aimPos: Vec2;
  aimVel: Vec2;
  targetKind: 'unit' | 'munition';
  seekerActive: boolean;
  decoyDistractedId?: string;
  interceptedAtTick?: number;
}

export interface FactionRuntimeState {
  resources: Record<ResourceType, number>;
  freighterCap: number;
  freightersInFlight: number;
  wonder: WonderSlot[];
}

export interface WorldState {
  tick: number;
  gameTimeSec: number;
  celestials: readonly CelestialBody[];
  units: Map<string, UnitEntity>;
  munitions: Map<string, MunitionEntity>;
  munitionMeta: Map<string, MunitionRuntimeMeta>;
  nextMunitionSeqByFaction: Record<FactionId, number>;
  tracksByFaction: Record<FactionId, SensorTrack[]>;
  trackMemoryByFaction: Record<FactionId, Map<string, InternalTrackRecord>>;
  nextTrackSeqByFaction: Record<FactionId, number>;
  sensorBlindUntilSec: Map<string, number>;
  laserActiveUnitIds: Set<string>;
  launchedDronesByCarrier: Map<string, number>;
  routesByFaction: Record<FactionId, LogisticsRoute[]>;
  factions: Record<FactionId, FactionRuntimeState>;
  vfxEvents: VfxEvent[];
  winner: FactionId | null;
}

function createInitialWonderSlots(): WonderSlot[] {
  const slots: WonderSlot[] = [];
  for (let index = 0; index < WONDER_CONFIG.slotCount; index++) {
    slots.push({
      index,
      status: 'empty',
      progressOre: 0,
      requiredOre: WONDER_CONFIG.orePerSlot,
      hp: WONDER_CONFIG.slotMaxHp,
      maxHp: WONDER_CONFIG.slotMaxHp,
    });
  }
  return slots;
}

export function createUnitEntity(params: {
  id: string;
  faction: FactionId;
  kind: UnitKind;
  orbit: KeplerOrbit;
  gameTimeSec?: number;
  propulsion?: PropulsionType;
  emconSilent?: boolean;
  radarActive?: boolean;
  jammerActive?: boolean;
}): UnitEntity {
  const cfg = UNIT_CONFIGS[params.kind];
  const tSec = params.gameTimeSec ?? 0;
  const state = orbitToState(params.orbit, tSec);
  const emconSilent = params.emconSilent ?? false;

  return {
    id: params.id,
    faction: params.faction,
    kind: params.kind,
    propulsion: params.propulsion ?? cfg.defaultPropulsion,
    pos: state.pos,
    vel: state.vel,
    orbit: { ...params.orbit },
    hp: cfg.maxHp,
    maxHp: cfg.maxHp,
    subsystems: {
      propulsion: 'normal',
      sensors: 'normal',
      weapons: 'normal',
      thermal: 'normal',
    },
    deltaV: cfg.maxDeltaV,
    maxDeltaV: cfg.maxDeltaV,
    heat: 0,
    maxHeat: cfg.maxHeat,
    radiatorsOpen: !emconSilent,
    emconSilent,
    radarActive: emconSilent ? false : (params.radarActive ?? false),
    jammerActive: emconSilent ? false : (params.jammerActive ?? false),
    ammoStock: cfg.weapons.ammoCapacity,
    plannedBurns: [],
  };
}

/**
 * Creates a fresh symmetric inner-solar-system match state for Earth vs Mars.
 */
export function createInitialWorldState(): WorldState {
  const earthOrbit = CELESTIAL_BODIES_BY_ID.earth!.orbit!;
  const marsOrbit = CELESTIAL_BODIES_BY_ID.mars!.orbit!;

  const initialUnits: UnitEntity[] = [
    createUnitEntity({
      id: 'earth-home-base',
      faction: 'earth',
      kind: 'home_base',
      orbit: earthOrbit,
      radarActive: true,
    }),
    createUnitEntity({
      id: 'earth-recon-1',
      faction: 'earth',
      kind: 'recon_corvette',
      orbit: { ...earthOrbit, a: 1.03, meanAnomaly0: 0.05 },
    }),
    createUnitEntity({
      id: 'earth-raider-1',
      faction: 'earth',
      kind: 'raider',
      orbit: { ...earthOrbit, a: 1.01, meanAnomaly0: 6.22 },
      emconSilent: true,
    }),
    createUnitEntity({
      id: 'earth-cruiser-1',
      faction: 'earth',
      kind: 'cruiser',
      orbit: { ...earthOrbit, a: 1.04, meanAnomaly0: 0.02 },
    }),
    createUnitEntity({
      id: 'earth-tanker-1',
      faction: 'earth',
      kind: 'tanker',
      orbit: { ...earthOrbit, a: 0.99, meanAnomaly0: 6.26 },
    }),
    createUnitEntity({
      id: 'mars-home-base',
      faction: 'mars',
      kind: 'home_base',
      orbit: marsOrbit,
      radarActive: true,
    }),
    createUnitEntity({
      id: 'mars-recon-1',
      faction: 'mars',
      kind: 'recon_corvette',
      orbit: { ...marsOrbit, a: 1.49, meanAnomaly0: 0.72 },
    }),
    createUnitEntity({
      id: 'mars-raider-1',
      faction: 'mars',
      kind: 'raider',
      orbit: { ...marsOrbit, a: 1.5, meanAnomaly0: 0.78 },
      emconSilent: true,
    }),
    createUnitEntity({
      id: 'mars-cruiser-1',
      faction: 'mars',
      kind: 'cruiser',
      orbit: { ...marsOrbit, a: 1.54, meanAnomaly0: 0.74 },
    }),
    createUnitEntity({
      id: 'mars-tanker-1',
      faction: 'mars',
      kind: 'tanker',
      orbit: { ...marsOrbit, a: 1.51, meanAnomaly0: 0.76 },
    }),
  ];

  return {
    tick: 0,
    gameTimeSec: 0,
    celestials: SOLAR_SYSTEM_BODIES,
    units: new Map(initialUnits.map((u) => [u.id, u])),
    munitions: new Map(),
    munitionMeta: new Map(),
    nextMunitionSeqByFaction: {
      earth: 1,
      mars: 1,
    },
    tracksByFaction: {
      earth: [],
      mars: [],
    },
    trackMemoryByFaction: {
      earth: new Map(),
      mars: new Map(),
    },
    nextTrackSeqByFaction: {
      earth: 1,
      mars: 1,
    },
    sensorBlindUntilSec: new Map(),
    laserActiveUnitIds: new Set(),
    launchedDronesByCarrier: new Map(),
    routesByFaction: {
      earth: [],
      mars: [],
    },
    factions: {
      earth: {
        resources: { ore: 400, propellant: 250 },
        freighterCap: LOGISTICS_CONFIG.initialFreighterCap,
        freightersInFlight: 0,
        wonder: createInitialWonderSlots(),
      },
      mars: {
        resources: { ore: 400, propellant: 250 },
        freighterCap: LOGISTICS_CONFIG.initialFreighterCap,
        freightersInFlight: 0,
        wonder: createInitialWonderSlots(),
      },
    },
    vfxEvents: [],
    winner: null,
  };
}

function cloneUnit(u: UnitEntity): UnitEntity {
  return {
    ...u,
    pos: { ...u.pos },
    vel: { ...u.vel },
    orbit: { ...u.orbit },
    subsystems: { ...u.subsystems },
    ...(u.cargo ? { cargo: { ...u.cargo } } : {}),
    plannedBurns: u.plannedBurns.map((b) => ({
      ...b,
      deltaV: { ...b.deltaV },
    })),
  };
}

function cloneMunition(m: MunitionEntity): MunitionEntity {
  return {
    ...m,
    pos: { ...m.pos },
    vel: { ...m.vel },
    orbit: { ...m.orbit },
  };
}

/**
 * Builds an authoritative per-faction snapshot enforcing the fog-of-war red line:
 * enemy units and enemy munitions are NEVER included in `ownUnits` or `ownMunitions`.
 */
export function buildFactionSnapshot(world: WorldState, faction: FactionId): FactionSnapshot {
  const enemyFaction: FactionId = faction === 'earth' ? 'mars' : 'earth';
  const factionState = world.factions[faction];
  const enemyWonder = world.factions[enemyFaction].wonder;

  const ownUnits: UnitEntity[] = [];
  for (const unit of world.units.values()) {
    if (unit.faction === faction) {
      ownUnits.push(cloneUnit(unit));
    }
  }

  const ownMunitions: MunitionEntity[] = [];
  for (const munition of world.munitions.values()) {
    if (munition.faction === faction) {
      ownMunitions.push(cloneMunition(munition));
    }
  }

  return {
    tick: world.tick,
    gameTimeSec: world.gameTimeSec,
    faction,
    resources: { ...factionState.resources },
    freighterCap: factionState.freighterCap,
    freightersInFlight: factionState.freightersInFlight,
    celestials: world.celestials.map((body) => {
      const state = getBodyStateAt(body, world.gameTimeSec);
      return {
        id: body.id,
        pos: state.pos,
        vel: state.vel,
      };
    }),
    ownUnits,
    ownMunitions,
    tracks: world.tracksByFaction[faction].map((t) => ({
      ...t,
      ...(t.originPos ? { originPos: { ...t.originPos } } : {}),
      ...(t.pos ? { pos: { ...t.pos } } : {}),
      ...(t.vel ? { vel: { ...t.vel } } : {}),
      ...(t.estimatedOrbit ? { estimatedOrbit: { ...t.estimatedOrbit } } : {}),
    })),
    routes: world.routesByFaction[faction].map((r) => ({
      ...r,
      ...(r.detourWaypoint ? { detourWaypoint: { ...r.detourWaypoint } } : {}),
      escortUnitIds: [...r.escortUnitIds],
    })),
    ownWonder: factionState.wonder.map((slot) => ({ ...slot })),
    enemyWonderPublicProgress: enemyWonder.filter((slot) => slot.status === 'complete').length,
    vfxEvents: world.vfxEvents.map((ev) => ({
      ...ev,
      from: { ...ev.from },
      ...(ev.to ? { to: { ...ev.to } } : {}),
    })),
    winner: world.winner,
  };
}
