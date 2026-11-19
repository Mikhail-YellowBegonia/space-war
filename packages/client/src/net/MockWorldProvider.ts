import {
  CELESTIAL_BODIES_BY_ID,
  LOGISTICS_CONFIG,
  MUNITION_CONFIGS,
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
  stateToOrbit,
  type CelestialBody,
  type FactionId,
  type FactionSnapshot,
  type InterceptTarget,
  type KeplerOrbit,
  type LogisticsRoute,
  type MunitionEntity,
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
  private readonly munitions = new Map<string, MunitionEntity>();
  private readonly interceptedTrackIds = new Set<string>();
  private readonly routes: LogisticsRoute[] = [];
  private readonly ownWonder: WonderSlot[] = createInitialWonderSlots();
  private resources = { ore: 1200, propellant: 500 };
  private freighterCap: number = LOGISTICS_CONFIG.initialFreighterCap;
  private freightersInFlight = 1;
  private readonly launchedDronesByCarrier = new Map<string, number>();
  private nextDroneSeq = 1;
  private nextMunitionSeq = 1;
  private nextBuildSeq = 1;
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
        id: isEarth ? 'E-ESC-1' : 'M-ESC-1',
        faction: this.faction,
        kind: 'escort_frigate',
        orbit: { ...homeOrbit, a: homeOrbit.a + 0.03, meanAnomaly0: homeOrbit.meanAnomaly0 - 0.015 },
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

    this.routes.push(
      {
        id: `${this.faction}-route-1`,
        faction: this.faction,
        sourceBodyId: isEarth ? 'venus' : 'ceres',
        targetId: isEarth ? 'E-HOME' : 'M-HOME',
        resource: isEarth ? 'ore' : 'propellant',
        paused: false,
        batchSize: 1,
        transferMode: 'fuel',
        escortUnitIds: [],
      },
      {
        id: `${this.faction}-route-2`,
        faction: this.faction,
        sourceBodyId: 'eros',
        targetId: isEarth ? 'E-HOME' : 'M-HOME',
        resource: isEarth ? 'propellant' : 'ore',
        paused: false,
        batchSize: 2,
        transferMode: 'stealth',
        escortUnitIds: [],
      },
    );

    if (this.ownWonder[0]) {
      this.ownWonder[0] = {
        ...this.ownWonder[0],
        status: 'complete',
        progressOre: this.ownWonder[0].requiredOre,
      };
    }
    if (this.ownWonder[1]) {
      this.ownWonder[1] = {
        ...this.ownWonder[1],
        status: 'building',
        progressOre: 220,
      };
    }
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
      const cfg = UNIT_CONFIGS[unit.kind];

      // Lightweight thermal feedback so the heat sink bar responds in Mock mode
      let heatDelta = cfg.baseHeatGenPerSec * dtSec;
      if (result.activeBurn) {
        heatDelta += result.usedDeltaV * 1800;
      }
      if (result.unit.ladarTargetAngle !== undefined && !result.unit.emconSilent) {
        heatDelta += cfg.sensors.ladarHeatPerSec * dtSec;
      }
      if (result.unit.radiatorsOpen && !result.unit.emconSilent) {
        heatDelta -= cfg.radiatorCoolingPerSec * dtSec;
      }
      const nextHeat = Math.max(0, Math.min(result.unit.maxHeat, result.unit.heat + heatDelta));

      this.units.set(id, { ...result.unit, heat: nextHeat });
      if (result.activeBurn) {
        events.push({
          kind: 'burn_flash',
          from: { ...result.unit.pos },
          intensity: unit.propulsion === 'nuclear' ? 1.0 : unit.propulsion === 'chemical' ? 0.65 : 0.2,
        });
      }
    }

    const tEnd = tStart + dtSec;
    const trackMap = new Map(this.buildScriptedTracks().map((t) => [t.trackId, t]));

    for (const [munId, mun] of this.munitions.entries()) {
      if (mun.intercepted) continue;
      const targetTrack = trackMap.get(mun.targetId);
      const nextState = orbitToState(mun.orbit, tEnd);
      const pos = nextState.pos;
      let vel = nextState.vel;
      let orbit = mun.orbit;
      let deltaV = mun.deltaV;
      let coldCoast = mun.coldCoast;

      if (targetTrack?.pos && deltaV > 0) {
        const dx = targetTrack.pos.x - pos.x;
        const dy = targetTrack.pos.y - pos.y;
        const dist = Math.hypot(dx, dy);

        if (dist <= 0.015) {
          this.munitions.set(munId, { ...mun, pos, vel, intercepted: true });
          if (targetTrack.suspectedKind === 'munition') {
            this.interceptedTrackIds.add(targetTrack.trackId);
          }
          events.push({
            kind: targetTrack.suspectedKind === 'munition' ? 'ciws' : 'explosion',
            from: { ...pos },
            intensity: 0.9,
          });
          continue;
        }

        // Terminal active guidance (or active mid-course for non-cold-coast interceptors)
        if (!coldCoast || dist <= MUNITION_CONFIGS[mun.profileId].seekerRangeAu) {
          coldCoast = false;
          const cfg = MUNITION_CONFIGS[mun.profileId];
          const maxStepDv = Math.min(deltaV, cfg.maxAccelAuPerSec2 * dtSec);
          const targetVel = targetTrack.vel ?? { x: 0, y: 0 };
          const closureSpeed = Math.min(0.004, Math.max(0.002, dist * 0.08));
          const desiredVx = targetVel.x + (dx / dist) * closureSpeed;
          const desiredVy = targetVel.y + (dy / dist) * closureSpeed;
          const dvx = desiredVx - vel.x;
          const dvy = desiredVy - vel.y;
          const dvMag = Math.hypot(dvx, dvy);
          if (dvMag > 1e-8 && maxStepDv > 0) {
            const scale = Math.min(1, maxStepDv / dvMag);
            vel = { x: vel.x + dvx * scale, y: vel.y + dvy * scale };
            deltaV = Math.max(0, deltaV - dvMag * scale);
            orbit = stateToOrbit(pos, vel, tEnd);
          }
        }
      }

      this.munitions.set(munId, {
        ...mun,
        pos,
        vel,
        orbit,
        deltaV,
        coldCoast,
      });
    }

    this.tick += 1;
    this.gameTimeSec = tEnd;
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

    const tracks: SensorTrack[] = [
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

    // Scripted incoming enemy munition tracks near friendly space for SW-17 anti-missile interception
    const homeBaseOrbit =
      this.faction === 'earth'
        ? CELESTIAL_BODIES_BY_ID.earth!.orbit!
        : CELESTIAL_BODIES_BY_ID.mars!.orbit!;
    const incomingSalvoSpecs: Array<{ id: string; da: number; dm: number; conf: 'confirmed' | 'uncertain' }> = [
      { id: `trk-${enemyFaction}-torp-1`, da: 0.05, dm: 0.04, conf: 'confirmed' },
      { id: `trk-${enemyFaction}-torp-2`, da: 0.06, dm: 0.055, conf: 'uncertain' },
    ];
    for (const spec of incomingSalvoSpecs) {
      if (this.interceptedTrackIds.has(spec.id)) continue;
      const torpOrbit: KeplerOrbit = {
        a: homeBaseOrbit.a + spec.da,
        e: 0.06,
        omega: homeBaseOrbit.omega,
        meanAnomaly0: homeBaseOrbit.meanAnomaly0 + spec.dm,
        epochSec: 0,
      };
      const torpState = orbitToState(torpOrbit, this.gameTimeSec);
      tracks.push({
        trackId: spec.id,
        confidence: spec.conf,
        suspectedKind: 'munition',
        pos: torpState.pos,
        vel: torpState.vel,
        ...(spec.conf === 'uncertain'
          ? { errorRadiusMajorAu: 0.03, errorRadiusMinorAu: 0.015, errorAngleRad: 0.25 }
          : {}),
        estimatedOrbit: torpOrbit,
        lastObservedSec: this.gameTimeSec,
        isJammed: false,
      });
    }

    return tracks;
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
      resources: { ...this.resources },
      freighterCap: this.freighterCap,
      freightersInFlight: this.freightersInFlight,
      celestials,
      ownUnits,
      ownMunitions: Array.from(this.munitions.values())
        .filter((m) => !m.intercepted)
        .map((m) => ({
          ...m,
          pos: { ...m.pos },
          vel: { ...m.vel },
          orbit: { ...m.orbit },
        })),
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
        if (command.angleRad !== null && unit.subsystems.sensors === 'offline') {
          return { accepted: false, reason: 'Sensor subsystem is offline' };
        }
        if (command.angleRad !== null && UNIT_CONFIGS[unit.kind].sensors.ladarRangeAu <= 0) {
          return { accepted: false, reason: 'Unit is not equipped with LADAR' };
        }
        this.units.set(unit.id, {
          ...unit,
          ladarTargetAngle: command.angleRad === null ? undefined : command.angleRad,
        });
        this.emitSnapshot();
        return { accepted: true };
      }

      case 'launch_drone': {
        const carrier = this.units.get(command.unitId);
        if (!carrier) {
          return { accepted: false, reason: `Unknown unit: ${command.unitId}` };
        }
        const capacity = UNIT_CONFIGS[carrier.kind].weapons.droneCapacity;
        if (capacity <= 0) {
          return { accepted: false, reason: `${carrier.kind} has no drone bay` };
        }
        const used = this.launchedDronesByCarrier.get(carrier.id) ?? 0;
        if (used >= capacity) {
          return { accepted: false, reason: 'Carrier drone bay capacity exhausted' };
        }

        const droneId = `${carrier.id}-D${this.nextDroneSeq++}`;
        const droneOrbit: KeplerOrbit = command.targetOrbit
          ? { ...command.targetOrbit }
          : {
              ...carrier.orbit,
              a: carrier.orbit.a + 0.015,
              meanAnomaly0: carrier.orbit.meanAnomaly0 + 0.02 * (used + 1),
            };
        const drone = createMockUnit({
          id: droneId,
          faction: this.faction,
          kind: command.droneKind,
          orbit: droneOrbit,
          gameTimeSec: this.gameTimeSec,
          emconSilent: command.droneKind === 'drone_recon',
          radarActive: command.droneKind === 'drone_ew',
        });
        if (command.droneKind === 'drone_ew') {
          drone.jammerActive = true;
        }
        this.units.set(droneId, drone);
        this.launchedDronesByCarrier.set(carrier.id, used + 1);
        this.emitSnapshot();
        return { accepted: true };
      }

      case 'fire_munition': {
        const shooter = this.units.get(command.unitId);
        if (!shooter) {
          return { accepted: false, reason: `Unknown unit: ${command.unitId}` };
        }
        if (shooter.hp <= 0 || shooter.subsystems.weapons === 'offline') {
          return { accepted: false, reason: 'Weapons offline or unit destroyed' };
        }
        const count = Math.max(1, Math.floor(command.count));
        if (shooter.ammoStock < count) {
          return { accepted: false, reason: 'Insufficient ammo stock' };
        }
        const targetTrack = this.buildScriptedTracks().find(
          (t) => t.trackId === command.targetTrackId,
        );
        if (
          !targetTrack ||
          (targetTrack.confidence !== 'confirmed' && targetTrack.confidence !== 'uncertain') ||
          !targetTrack.pos
        ) {
          return { accepted: false, reason: 'Target track is not confirmed or uncertain' };
        }

        const cfg = MUNITION_CONFIGS[command.profileId];
        const coldCoast = cfg.canColdCoast ? command.coldCoast : false;
        const dx = targetTrack.pos.x - shooter.pos.x;
        const dy = targetTrack.pos.y - shooter.pos.y;
        const dist = Math.max(1e-6, Math.hypot(dx, dy));
        const ux = dx / dist;
        const uy = dy / dist;

        for (let i = 0; i < count; i++) {
          const spreadAngle = (i - (count - 1) * 0.5) * 0.08;
          const cosS = Math.cos(spreadAngle);
          const sinS = Math.sin(spreadAngle);
          const dirX = ux * cosS - uy * sinS;
          const dirY = ux * sinS + uy * cosS;
          const boost = Math.min(cfg.maxDeltaV * 0.2, 0.0015);
          const vel = {
            x: shooter.vel.x + dirX * boost,
            y: shooter.vel.y + dirY * boost,
          };
          const orbit = stateToOrbit(shooter.pos, vel, this.gameTimeSec);
          const munId = `mun-${this.nextMunitionSeq++}`;
          this.munitions.set(munId, {
            id: munId,
            faction: this.faction,
            profileId: command.profileId,
            pos: { ...shooter.pos },
            vel,
            orbit,
            deltaV: Math.max(0, cfg.maxDeltaV - boost),
            targetId: command.targetTrackId,
            seekerMode: cfg.defaultSeekerMode,
            coldCoast,
            intercepted: false,
          });
        }

        this.units.set(shooter.id, {
          ...shooter,
          ammoStock: shooter.ammoStock - count,
        });
        this.emitSnapshot();
        return { accepted: true };
      }

      case 'update_route': {
        const idx = this.routes.findIndex((r) => r.id === command.routeId);
        if (idx === -1) {
          return { accepted: false, reason: `Unknown route: ${command.routeId}` };
        }
        this.routes[idx] = {
          ...this.routes[idx]!,
          ...command.patch,
        };
        this.emitSnapshot();
        return { accepted: true };
      }

      case 'queue_build': {
        if (command.kind === 'freighter_cap') {
          if (this.resources.ore < LOGISTICS_CONFIG.freighterCapCostOre) {
            return { accepted: false, reason: 'Insufficient Ore' };
          }
          this.resources.ore -= LOGISTICS_CONFIG.freighterCapCostOre;
          this.freighterCap += 1;
          this.emitSnapshot();
          return { accepted: true };
        }

        if (command.kind === 'wonder_slot') {
          if (this.resources.ore < WONDER_CONFIG.orePerSlot) {
            return { accepted: false, reason: 'Insufficient Ore for wonder slot' };
          }
          const emptySlot = this.ownWonder.find((s) => s.status === 'empty');
          if (!emptySlot) {
            return { accepted: false, reason: 'No empty wonder slots remaining' };
          }
          this.resources.ore -= WONDER_CONFIG.orePerSlot;
          emptySlot.status = 'building';
          emptySlot.progressOre = emptySlot.requiredOre * 0.25;
          this.emitSnapshot();
          return { accepted: true };
        }

        if (command.kind === 'relay_depot') {
          const cfg = UNIT_CONFIGS.relay_depot;
          if (this.resources.ore < cfg.costOre || this.resources.propellant < cfg.costPropellant) {
            return { accepted: false, reason: 'Insufficient resources for relay depot' };
          }
          const pos =
            typeof command.targetRef === 'object' && command.targetRef !== null
              ? command.targetRef
              : { x: 1.25, y: 0.25 };
          this.resources.ore -= cfg.costOre;
          this.resources.propellant -= cfg.costPropellant;
          const r = Math.max(0.3, Math.hypot(pos.x, pos.y));
          const angle = Math.atan2(pos.y, pos.x);
          const id = `${this.faction === 'earth' ? 'E' : 'M'}-RLY-${this.nextBuildSeq++}`;
          this.units.set(
            id,
            createMockUnit({
              id,
              faction: this.faction,
              kind: 'relay_depot',
              orbit: { a: r, e: 0.02, omega: angle, meanAnomaly0: 0, epochSec: this.gameTimeSec },
              gameTimeSec: this.gameTimeSec,
            }),
          );
          this.emitSnapshot();
          return { accepted: true };
        }

        if (command.kind === 'outpost') {
          const cfg = UNIT_CONFIGS.mining_outpost;
          if (this.resources.ore < cfg.costOre || this.resources.propellant < cfg.costPropellant) {
            return { accepted: false, reason: 'Insufficient resources for mining outpost' };
          }
          const bodyId = typeof command.targetRef === 'string' ? command.targetRef : 'eros';
          const body = CELESTIAL_BODIES_BY_ID[bodyId];
          if (!body?.orbit) {
            return { accepted: false, reason: `Invalid outpost body: ${bodyId}` };
          }
          this.resources.ore -= cfg.costOre;
          this.resources.propellant -= cfg.costPropellant;
          const id = `${this.faction === 'earth' ? 'E' : 'M'}-OUT-${this.nextBuildSeq++}`;
          this.units.set(
            id,
            createMockUnit({
              id,
              faction: this.faction,
              kind: 'mining_outpost',
              orbit: { ...body.orbit },
              gameTimeSec: this.gameTimeSec,
            }),
          );
          this.emitSnapshot();
          return { accepted: true };
        }

        const unitKind = command.kind as UnitKind;
        const cfg = UNIT_CONFIGS[unitKind];
        if (!cfg || cfg.buildLocation !== 'home_base_only') {
          return { accepted: false, reason: `Cannot build ${command.kind} at home base` };
        }
        if (this.resources.ore < cfg.costOre || this.resources.propellant < cfg.costPropellant) {
          return { accepted: false, reason: 'Insufficient resources' };
        }
        this.resources.ore -= cfg.costOre;
        this.resources.propellant -= cfg.costPropellant;
        const homeOrbit = CELESTIAL_BODIES_BY_ID[this.faction]!.orbit!;
        const seq = this.nextBuildSeq++;
        const id = `${this.faction === 'earth' ? 'E' : 'M'}-${unitKind.slice(0, 3).toUpperCase()}-${seq}`;
        this.units.set(
          id,
          createMockUnit({
            id,
            faction: this.faction,
            kind: unitKind,
            orbit: {
              ...homeOrbit,
              a: homeOrbit.a + 0.045,
              meanAnomaly0: homeOrbit.meanAnomaly0 + 0.03 * seq,
            },
            gameTimeSec: this.gameTimeSec,
          }),
        );
        this.emitSnapshot();
        return { accepted: true };
      }
    }
  }

  private emitSnapshot(): void {
    const snap = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snap);
    }
  }
}
