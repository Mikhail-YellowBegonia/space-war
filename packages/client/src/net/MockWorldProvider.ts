import {
  CELESTIAL_BODIES_BY_ID,
  LOGISTICS_CONFIG,
  SIM_TICK_RATE_HZ,
  SOLAR_SYSTEM_BODIES,
  UNIT_CONFIGS,
  WONDER_CONFIG,
  advanceUnitOrbit,
  getBodyStateAt,
  isOccluded,
  orbitToState,
  solveInterceptTransfer,
  solveOrbitInsertion,
  type CelestialBody,
  type FactionId,
  type FactionSnapshot,
  type InterceptTarget,
  type KeplerOrbit,
  type LogisticsRoute,
  type PlayerCommand,
  type PropulsionType,
  type ResupplyPoint,
  type SensorTrack,
  type UnitEntity,
  type UnitKind,
  type Vec2,
  type VfxEvent,
  type WonderSlot,
} from '@space-war/shared';
import type { CommandAck, IWorldProvider, SnapshotListener } from './IWorldProvider.js';

export interface MockWorldProviderOptions {
  faction?: FactionId;
  autoStart?: boolean;
  tickRateHz?: number;
}

function createMockUnit(params: {
  id: string;
  faction: FactionId;
  kind: UnitKind;
  orbit: KeplerOrbit;
  gameTimeSec?: number;
  propulsion?: PropulsionType;
  deltaVOverride?: number;
  emconSilent?: boolean;
  radarActive?: boolean;
}): UnitEntity {
  const cfg = UNIT_CONFIGS[params.kind];
  const tSec = params.gameTimeSec ?? 0;
  const state = orbitToState(params.orbit, tSec);
  const emconSilent = params.emconSilent ?? false;
  const deltaV = params.deltaVOverride ?? cfg.maxDeltaV;

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
    deltaV,
    maxDeltaV: cfg.maxDeltaV,
    heat: 0,
    maxHeat: cfg.maxHeat,
    radiatorsOpen: !emconSilent,
    emconSilent,
    radarActive: emconSilent ? false : (params.radarActive ?? false),
    jammerActive: false,
    ammoStock: cfg.weapons.ammoCapacity,
    plannedBurns: [],
  };
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

function cloneUnit(unit: UnitEntity): UnitEntity {
  return {
    ...unit,
    pos: { ...unit.pos },
    vel: { ...unit.vel },
    orbit: { ...unit.orbit },
    subsystems: { ...unit.subsystems },
    cargo: unit.cargo ? { ...unit.cargo } : undefined,
    plannedBurns: unit.plannedBurns.map((b) => ({ ...b, deltaV: { ...b.deltaV } })),
  };
}

/**
 * Pure frontend world provider backed by `@space-war/shared` ephemeris, Kepler propulsion,
 * and transfer/Bingo solvers so UI & orbital interaction can be developed and verified
 * without a running backend server.
 */
export class MockWorldProvider implements IWorldProvider {
  readonly faction: FactionId;
  private readonly tickRateHz: number;
  private readonly listeners = new Set<SnapshotListener>();

  private tick = 0;
  private gameTimeSec = 0;
  private readonly bodies: readonly CelestialBody[] = SOLAR_SYSTEM_BODIES;
  private readonly units = new Map<string, UnitEntity>();
  private readonly routes: LogisticsRoute[] = [];
  private readonly ownWonder: WonderSlot[] = createInitialWonderSlots();
  private vfxEvents: VfxEvent[] = [];
  private timerId: ReturnType<typeof setInterval> | null = null;
  private scriptedRaiderOrbit: KeplerOrbit = {
    a: 1.38,
    e: 0.14,
    omega: 0.32,
    meanAnomaly0: 0.5,
    epochSec: 0,
  };
  private raiderLastObservedSec = 0;

  constructor(options: MockWorldProviderOptions = {}) {
    this.faction = options.faction ?? 'earth';
    this.tickRateHz = options.tickRateHz ?? SIM_TICK_RATE_HZ;
    this.seedInitialState();

    if (options.autoStart) {
      this.start();
    }
  }

  private seedInitialState(): void {
    const earthOrbit = CELESTIAL_BODIES_BY_ID.earth!.orbit!;
    const marsOrbit = CELESTIAL_BODIES_BY_ID.mars!.orbit!;
    const isEarth = this.faction === 'earth';
    const homeOrbit = isEarth ? earthOrbit : marsOrbit;

    const seededUnits: UnitEntity[] = [
      createMockUnit({
        id: isEarth ? 'E-HOME' : 'M-HOME',
        faction: this.faction,
        kind: 'home_base',
        orbit: homeOrbit,
        radarActive: true,
      }),
      createMockUnit({
        id: isEarth ? 'E-RCN-1' : 'M-RCN-1',
        faction: this.faction,
        kind: 'recon_corvette',
        orbit: { ...homeOrbit, a: homeOrbit.a + 0.04, meanAnomaly0: homeOrbit.meanAnomaly0 + 0.05 },
      }),
      createMockUnit({
        id: isEarth ? 'E-RDR-1' : 'M-RDR-1',
        faction: this.faction,
        kind: 'raider',
        orbit: { ...homeOrbit, a: homeOrbit.a + 0.02, meanAnomaly0: homeOrbit.meanAnomaly0 - 0.06 },
        // Tight delta-v so Earth-Mars strikes are feasible yet trigger Bingo red-line warnings
        deltaVOverride: 0.0085,
        emconSilent: true,
      }),
      createMockUnit({
        id: isEarth ? 'E-CRS-1' : 'M-CRS-1',
        faction: this.faction,
        kind: 'cruiser',
        orbit: { ...homeOrbit, a: homeOrbit.a + 0.06, meanAnomaly0: homeOrbit.meanAnomaly0 + 0.02 },
      }),
      createMockUnit({
        id: isEarth ? 'E-TNK-1' : 'M-TNK-1',
        faction: this.faction,
        kind: 'tanker',
        orbit: { ...homeOrbit, a: Math.max(0.4, homeOrbit.a - 0.02), meanAnomaly0: homeOrbit.meanAnomaly0 - 0.03 },
      }),
    ];

    for (const unit of seededUnits) {
      if (unit.kind === 'recon_corvette') {
        unit.ladarTargetAngle = 0.45;
      }
      this.units.set(unit.id, unit);
    }

    this.routes.push({
      id: `${this.faction}-route-1`,
      faction: this.faction,
      sourceBodyId: isEarth ? 'venus' : 'ceres',
      targetId: isEarth ? 'E-HOME' : 'M-HOME',
      resource: isEarth ? 'ore' : 'propellant',
      paused: false,
      batchSize: 1,
      transferMode: 'fuel',
      escortUnitIds: [],
    });
  }

  start(): void {
    if (this.timerId !== null) {
      return;
    }
    const intervalMs = Math.max(16, Math.round(1000 / this.tickRateHz));
    this.timerId = setInterval(() => {
      this.step(1 / this.tickRateHz);
    }, intervalMs);
  }

  stop(): void {
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  dispose(): void {
    this.stop();
    this.listeners.clear();
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Advances mock orbital simulation synchronously by `dtSec` and notifies subscribers.
   */
  step(dtSec: number): void {
    if (dtSec <= 0) {
      return;
    }

    const tStart = this.gameTimeSec;
    const events: VfxEvent[] = [];

    for (const [id, unit] of this.units.entries()) {
      const result = advanceUnitOrbit(unit, tStart, dtSec);
      this.units.set(id, result.unit);
      if (result.activeBurn) {
        events.push({
          kind: 'burn_flash',
          from: { ...result.unit.pos },
          intensity: unit.propulsion === 'nuclear' ? 1.0 : unit.propulsion === 'chemical' ? 0.65 : 0.2,
        });
      }
    }

    this.tick += 1;
    this.gameTimeSec = tStart + dtSec;
    this.vfxEvents = events;
    this.emitSnapshot();
  }

  getFriendlyResupplySites(): ResupplyPoint[] {
    const sites: ResupplyPoint[] = [];
    for (const unit of this.units.values()) {
      if (unit.faction === this.faction && UNIT_CONFIGS[unit.kind].logistics.canResupply) {
        sites.push({ id: unit.id, orbit: { ...unit.orbit }, pos: { ...unit.pos } });
      }
    }
    return sites;
  }

  /**
   * Allows tests or scenarios to reposition the scripted enemy raider orbit (e.g. behind an occluder).
   */
  setScriptedRaiderOrbit(orbit: KeplerOrbit): void {
    this.scriptedRaiderOrbit = { ...orbit };
    this.emitSnapshot();
  }

  private isPosVisibleToOwnUnits(targetPos: Vec2): boolean {
    for (const unit of this.units.values()) {
      if (unit.hp <= 0 || unit.subsystems.sensors === 'offline') continue;
      if (!isOccluded(unit.pos, targetPos, this.bodies, this.gameTimeSec)) {
        return true;
      }
    }
    return false;
  }

  private buildScriptedTracks(): SensorTrack[] {
    const enemyFaction: FactionId = this.faction === 'earth' ? 'mars' : 'earth';
    const enemyHomeBody = CELESTIAL_BODIES_BY_ID[enemyFaction]!;
    const enemyBaseOrbit: KeplerOrbit = enemyHomeBody.orbit
      ? {
          ...enemyHomeBody.orbit,
          a: enemyHomeBody.orbit.a + 0.035,
          meanAnomaly0: enemyHomeBody.orbit.meanAnomaly0 + 0.05,
        }
      : { a: 1.55, e: 0.09, omega: 0.2, meanAnomaly0: 0.8, epochSec: 0 };
    const enemyHomeState = orbitToState(enemyBaseOrbit, this.gameTimeSec);

    const raiderState = orbitToState(this.scriptedRaiderOrbit, this.gameTimeSec);
    const raiderVisible = this.isPosVisibleToOwnUnits(raiderState.pos);
    if (raiderVisible) {
      this.raiderLastObservedSec = this.gameTimeSec;
    }

    const jammedEscortOrbit: KeplerOrbit = {
      a: 1.46,
      e: 0.08,
      omega: 0.28,
      meanAnomaly0: 0.62,
      epochSec: 0,
    };
    const jammedEscortState = orbitToState(jammedEscortOrbit, this.gameTimeSec);

    const ghostPatrolOrbit: KeplerOrbit = {
      a: 2.05,
      e: 0.12,
      omega: 2.8,
      meanAnomaly0: 0.2,
      epochSec: 0,
    };
    const ghostPatrolState = orbitToState(ghostPatrolOrbit, this.gameTimeSec);

    const reconHome = this.units.get(this.faction === 'earth' ? 'E-HOME' : 'M-HOME');
    const originPos = reconHome ? { ...reconHome.pos } : { x: 1, y: 0 };

    return [
      {
        trackId: `trk-${enemyFaction}-home`,
        confidence: 'confirmed',
        suspectedKind: 'station',
        pos: enemyHomeState.pos,
        vel: enemyHomeState.vel,
        estimatedOrbit: enemyBaseOrbit,
        lastObservedSec: this.gameTimeSec,
        isJammed: false,
      },
      {
        trackId: `trk-${enemyFaction}-raider`,
        confidence: raiderVisible ? 'uncertain' : 'ghost',
        suspectedKind: 'ship',
        pos: raiderState.pos,
        vel: raiderState.vel,
        errorRadiusMajorAu: 0.08,
        errorRadiusMinorAu: 0.035,
        errorAngleRad: 0.4,
        estimatedOrbit: this.scriptedRaiderOrbit,
        lastObservedSec: this.raiderLastObservedSec,
        isJammed: false,
      },
      {
        trackId: `trk-${enemyFaction}-jammed-escort`,
        confidence: 'uncertain',
        suspectedKind: 'ship',
        pos: jammedEscortState.pos,
        vel: jammedEscortState.vel,
        errorRadiusMajorAu: 0.14,
        errorRadiusMinorAu: 0.07,
        errorAngleRad: 0.9,
        lastObservedSec: this.gameTimeSec,
        isJammed: true,
      },
      {
        trackId: `trk-${enemyFaction}-ghost-patrol`,
        confidence: 'ghost',
        suspectedKind: 'freighter',
        pos: ghostPatrolState.pos,
        vel: ghostPatrolState.vel,
        estimatedOrbit: ghostPatrolOrbit,
        lastObservedSec: Math.max(0, this.gameTimeSec - 16),
        isJammed: false,
      },
      {
        trackId: `trk-${enemyFaction}-outer-esm`,
        confidence: 'bearing',
        suspectedKind: 'unknown',
        bearingRad: 2.15,
        originPos,
        lastObservedSec: this.gameTimeSec,
        isJammed: false,
      },
    ];
  }

  getSnapshot(): FactionSnapshot {
    const celestials = this.bodies.map((body) => {
      const state = getBodyStateAt(body, this.gameTimeSec);
      return {
        id: body.id,
        pos: state.pos,
        vel: state.vel,
      };
    });

    const ownUnits = Array.from(this.units.values()).map(cloneUnit);

    return {
      tick: this.tick,
      gameTimeSec: this.gameTimeSec,
      faction: this.faction,
      resources: { ore: 420, propellant: 260 },
      freighterCap: LOGISTICS_CONFIG.initialFreighterCap,
      freightersInFlight: 1,
      celestials,
      ownUnits,
      ownMunitions: [],
      tracks: this.buildScriptedTracks(),
      routes: this.routes.map((r) => ({ ...r, escortUnitIds: [...r.escortUnitIds] })),
      ownWonder: this.ownWonder.map((slot) => ({ ...slot })),
      enemyWonderPublicProgress: 0,
      vfxEvents: this.vfxEvents.map((e) => ({
        ...e,
        from: { ...e.from },
        to: e.to ? { ...e.to } : undefined,
      })),
      winner: null,
    };
  }

  private resolveInterceptTarget(targetRefId: string): InterceptTarget | null {
    const body = this.bodies.find((b) => b.id === targetRefId && b.orbit !== null);
    if (body) {
      return body;
    }

    const ownUnit = this.units.get(targetRefId);
    if (ownUnit) {
      return ownUnit;
    }

    const track = this.buildScriptedTracks().find((t) => t.trackId === targetRefId);
    if (track) {
      return track;
    }

    return null;
  }

  async sendCommand(command: PlayerCommand): Promise<CommandAck> {
    switch (command.type) {
      case 'plan_orbit_insertion': {
        const unit = this.units.get(command.unitId);
        if (!unit) {
          return { accepted: false, reason: `Unknown unit: ${command.unitId}` };
        }
        if (unit.deltaV <= 0) {
          return { accepted: false, reason: 'No remaining delta-v' };
        }
        const options = solveOrbitInsertion(
          {
            unit,
            nowSec: this.gameTimeSec,
            celestialBodies: this.bodies,
            friendlyResupplySites: this.getFriendlyResupplySites(),
          },
          command.targetOrbit,
        );
        const chosen = options[command.mode];
        if (!chosen.feasible) {
          return { accepted: false, reason: chosen.reason ?? 'Orbit insertion infeasible' };
        }
        this.units.set(unit.id, {
          ...unit,
          plannedBurns: chosen.burns.map((b) => ({ ...b, deltaV: { ...b.deltaV } })),
        });
        this.emitSnapshot();
        return { accepted: true };
      }

      case 'plan_intercept': {
        const unit = this.units.get(command.unitId);
        if (!unit) {
          return { accepted: false, reason: `Unknown unit: ${command.unitId}` };
        }
        if (unit.deltaV <= 0) {
          return { accepted: false, reason: 'No remaining delta-v' };
        }
        const target = this.resolveInterceptTarget(command.targetRefId);
        if (!target) {
          return { accepted: false, reason: `Unknown target: ${command.targetRefId}` };
        }
        const options = solveInterceptTransfer(
          {
            unit,
            nowSec: this.gameTimeSec,
            celestialBodies: this.bodies,
            friendlyResupplySites: this.getFriendlyResupplySites(),
          },
          target,
        );
        const chosen = options[command.mode];
        if (!chosen.feasible) {
          return { accepted: false, reason: chosen.reason ?? 'Intercept infeasible' };
        }
        this.units.set(unit.id, {
          ...unit,
          plannedBurns: chosen.burns.map((b) => ({ ...b, deltaV: { ...b.deltaV } })),
        });
        this.emitSnapshot();
        return { accepted: true };
      }

      case 'set_emcon': {
        const unit = this.units.get(command.unitId);
        if (!unit) {
          return { accepted: false, reason: `Unknown unit: ${command.unitId}` };
        }
        this.units.set(unit.id, {
          ...unit,
          emconSilent: command.silent,
          radiatorsOpen: command.silent ? false : command.radiatorsOpen,
          radarActive: command.silent ? false : command.radarActive,
          jammerActive: command.silent ? false : command.jammerActive,
        });
        this.emitSnapshot();
        return { accepted: true };
      }

      case 'set_ladar': {
        const unit = this.units.get(command.unitId);
        if (!unit) {
          return { accepted: false, reason: `Unknown unit: ${command.unitId}` };
        }
        this.units.set(unit.id, {
          ...unit,
          ladarTargetAngle: command.angleRad ?? undefined,
        });
        this.emitSnapshot();
        return { accepted: true };
      }

      default:
        return { accepted: false, reason: `Command ${command.type} not implemented in M1 mock` };
    }
  }

  private emitSnapshot(): void {
    const snap = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snap);
    }
  }
}
