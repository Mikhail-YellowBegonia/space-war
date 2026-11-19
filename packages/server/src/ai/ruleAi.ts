import {
  LOGISTICS_CONFIG,
  UNIT_CONFIGS,
  WONDER_CONFIG,
  type BuildQueueKind,
  type FactionId,
  type FactionSnapshot,
  type PlayerCommand,
  type SensorTrack,
  type UnitEntity,
  type UnitKind,
} from '@space-war/shared';
import { applyPlayerCommand, type CommandValidationResult } from '../engine/commandPipeline.js';
import type { TickSystemHook } from '../engine/simulationLoop.js';
import { buildFactionSnapshot, type WorldState } from '../engine/worldState.js';

export interface RuleAiOptions {
  decisionIntervalSec?: number;
  maxOutposts?: number;
  targetFreighterCap?: number;
}

export interface AiCommandLogEntry {
  gameTimeSec: number;
  command: PlayerCommand;
  result: CommandValidationResult;
}

const DEFAULT_OPTIONS: Required<RuleAiOptions> = {
  decisionIntervalSec: 3.0,
  maxOutposts: 4,
  targetFreighterCap: 5,
};

function wrapSignedAngle(rad: number): number {
  let wrapped = (rad + Math.PI) % (2 * Math.PI);
  if (wrapped < 0) {
    wrapped += 2 * Math.PI;
  }
  return wrapped - Math.PI;
}

/**
 * Simple rule-based test AI operating strictly on authoritative fog-of-war `FactionSnapshot`s
 * and standard `PlayerCommand` submissions (never peeking at unspotted enemy entities).
 */
export class SimpleRuleAiController {
  public readonly faction: FactionId;
  private readonly options: Required<RuleAiOptions>;
  private lastDecisionSec = -999;
  private readonly pendingBuildUntilSec = new Map<BuildQueueKind, number>();
  private readonly lastManeuverSecByUnit = new Map<string, number>();
  private readonly dispatchedPatrolByUnit = new Set<string>();
  private readonly lastFireSecByUnit = new Map<string, number>();
  private readonly lastMunitionInterceptSec = new Map<string, number>();
  private readonly lastDroneLaunchSecByUnit = new Map<string, number>();
  private patrolToggle = 0;
  public readonly commandHistory: AiCommandLogEntry[] = [];

  constructor(faction: FactionId, options: RuleAiOptions = {}) {
    this.faction = faction;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Evaluates one AI decision cycle if `decisionIntervalSec` has elapsed, returning submitted commands.
   */
  public step(world: WorldState): AiCommandLogEntry[] {
    if (world.winner !== null) {
      return [];
    }
    if (world.gameTimeSec - this.lastDecisionSec < this.options.decisionIntervalSec - 1e-6) {
      return [];
    }
    this.lastDecisionSec = world.gameTimeSec;

    const snapshot = buildFactionSnapshot(world, this.faction);
    if (!snapshot.ownUnits.some((u) => u.kind === 'home_base' && u.hp > 0)) {
      return [];
    }

    const emitted: AiCommandLogEntry[] = [];
    const dispatch = (command: PlayerCommand): boolean => {
      const result = applyPlayerCommand(world, this.faction, command);
      const entry: AiCommandLogEntry = {
        gameTimeSec: world.gameTimeSec,
        command,
        result,
      };
      emitted.push(entry);
      if (this.commandHistory.length < 500) {
        this.commandHistory.push(entry);
      }
      return result.accepted;
    };

    // Prune expired pending build cooldowns
    for (const [kind, untilSec] of this.pendingBuildUntilSec.entries()) {
      if (untilSec <= snapshot.gameTimeSec) {
        this.pendingBuildUntilSec.delete(kind);
      }
    }

    // Spend virtual available resources conservatively across commands in this same decision step
    let availOre = snapshot.resources.ore;
    let availProp = snapshot.resources.propellant;

    const tryQueueBuild = (
      kind: BuildQueueKind,
      costOre: number,
      costProp: number,
      buildTimeSec: number,
      targetRef?: string,
    ): boolean => {
      if (this.pendingBuildUntilSec.has(kind)) {
        return false;
      }
      if (availOre < costOre || availProp < costProp) {
        return false;
      }
      const ok = dispatch({
        type: 'queue_build',
        kind,
        ...(targetRef !== undefined ? { targetRef } : {}),
      });
      if (ok) {
        availOre -= costOre;
        availProp -= costProp;
        if (buildTimeSec > 0) {
          this.pendingBuildUntilSec.set(kind, snapshot.gameTimeSec + buildTimeSec);
        }
      }
      return ok;
    };

    // 1. Thermal self-protection & active combat reactions
    this.runThermalAndCombatRules(snapshot, dispatch);

    // 2. Logistics escort maintenance (prune dead escorts and bind idle frigates)
    this.runEscortBindingRules(snapshot, dispatch);

    // 3. Build priority: ensure at least 1 starter combat hull before spending all Ore on wonder
    const livingUnits = snapshot.ownUnits.filter((u) => u.hp > 0);
    const warships = livingUnits.filter(
      (u) => u.kind === 'raider' || u.kind === 'escort_frigate' || u.kind === 'cruiser',
    );
    const outposts = livingUnits.filter((u) => u.kind === 'mining_outpost');

    const raiderQueued = this.pendingBuildUntilSec.has('raider');
    const frigateQueued = this.pendingBuildUntilSec.has('escort_frigate');
    if (warships.length === 0 && !raiderQueued && !frigateQueued) {
      const cfg = UNIT_CONFIGS.raider;
      tryQueueBuild('raider', cfg.costOre, cfg.costPropellant, cfg.buildTimeSec);
    }

    // 4. Repair damaged wonder slots first, then construct up to maxConcurrentSlots
    const damagedWonder = snapshot.ownWonder.find((s) => s.status === 'damaged_halted');
    if (damagedWonder) {
      const repairCost = Math.round(WONDER_CONFIG.orePerSlot * WONDER_CONFIG.repairOreRatio);
      tryQueueBuild('wonder_slot', repairCost, 0, 0);
    }

    let buildingWonderCount = snapshot.ownWonder.filter((s) => s.status === 'building').length;
    const emptyWonderCount = snapshot.ownWonder.filter((s) => s.status === 'empty').length;
    let startedWonderThisStep = 0;
    if (warships.length > 0 || raiderQueued || snapshot.gameTimeSec >= 60) {
      while (
        buildingWonderCount < WONDER_CONFIG.maxConcurrentSlots &&
        startedWonderThisStep < emptyWonderCount &&
        tryQueueBuild('wonder_slot', WONDER_CONFIG.orePerSlot, 0, 0)
      ) {
        buildingWonderCount += 1;
        startedWonderThisStep += 1;
      }
    }

    // 5. Freighter capacity expansion & celestial mining outpost expansion
    if (
      snapshot.freighterCap < this.options.targetFreighterCap &&
      (snapshot.freightersInFlight >= Math.max(1, snapshot.freighterCap - 1) ||
        snapshot.freighterCap < 4)
    ) {
      tryQueueBuild(
        'freighter_cap',
        LOGISTICS_CONFIG.freighterCapCostOre,
        0,
        LOGISTICS_CONFIG.freighterCapBuildTimeSec,
      );
    }

    if (outposts.length < this.options.maxOutposts) {
      const outCfg = UNIT_CONFIGS.mining_outpost;
      tryQueueBuild('outpost', outCfg.costOre, outCfg.costPropellant, outCfg.buildTimeSec);
    }

    // 6. Fleet replenishment while keeping wonder funded
    const frigateCount = livingUnits.filter((u) => u.kind === 'escort_frigate').length;
    const raiderCount = livingUnits.filter((u) => u.kind === 'raider').length;
    const cruiserCount = livingUnits.filter((u) => u.kind === 'cruiser').length;

    const hasEmptyWonder = emptyWonderCount > startedWonderThisStep;
    const reserveForWonder = hasEmptyWonder && buildingWonderCount < WONDER_CONFIG.maxConcurrentSlots;
    if (!reserveForWonder || availOre >= WONDER_CONFIG.orePerSlot + 180) {
      if (frigateCount < 1) {
        const cfg = UNIT_CONFIGS.escort_frigate;
        tryQueueBuild('escort_frigate', cfg.costOre, cfg.costPropellant, cfg.buildTimeSec);
      } else if (raiderCount < 2) {
        const cfg = UNIT_CONFIGS.raider;
        tryQueueBuild('raider', cfg.costOre, cfg.costPropellant, cfg.buildTimeSec);
      } else if (cruiserCount < 1) {
        const cfg = UNIT_CONFIGS.cruiser;
        tryQueueBuild('cruiser', cfg.costOre, cfg.costPropellant, cfg.buildTimeSec);
      }
    }

    // 7. Patrol, commerce-raiding, and refuel maneuvers (with cooldown to keep CPU light)
    this.runPatrolAndManeuverRules(snapshot, dispatch);

    return emitted;
  }

  private runThermalAndCombatRules(
    snapshot: FactionSnapshot,
    dispatch: (cmd: PlayerCommand) => boolean,
  ): void {
    const nowSec = snapshot.gameTimeSec;
    const livingShips = snapshot.ownUnits.filter((u) => u.hp > 0);
    const shooters = livingShips.filter(
      (u) =>
        (u.kind === 'raider' ||
          u.kind === 'cruiser' ||
          u.kind === 'escort_frigate' ||
          u.kind === 'home_base') &&
        u.subsystems.weapons !== 'offline' &&
        u.ammoStock > 0,
    );

    // Thermal emergency venting & defensive EW / LADAR
    for (const unit of livingShips) {
      if (unit.kind === 'home_base' || unit.kind === 'mining_outpost' || unit.kind === 'freighter') {
        continue;
      }

      if (unit.heat >= unit.maxHeat * 0.78 && (unit.emconSilent || !unit.radiatorsOpen)) {
        dispatch({
          type: 'set_emcon',
          unitId: unit.id,
          silent: false,
          radiatorsOpen: true,
          radarActive: unit.kind === 'escort_frigate' || unit.kind === 'cruiser',
          jammerActive: false,
        });
      }

      // Close-range LADAR sweep on nearby bearing/uncertain contacts
      const cfg = UNIT_CONFIGS[unit.kind];
      if (
        cfg.sensors.ladarRangeAu > 0 &&
        unit.subsystems.sensors !== 'offline' &&
        !unit.emconSilent &&
        unit.heat < unit.maxHeat * 0.65
      ) {
        let nearestBearTrack: SensorTrack | undefined;
        let nearestDist = cfg.sensors.ladarRangeAu;
        for (const trk of snapshot.tracks) {
          if (trk.pos) {
            const d = Math.hypot(trk.pos.x - unit.pos.x, trk.pos.y - unit.pos.y);
            if (d <= nearestDist) {
              nearestDist = d;
              nearestBearTrack = trk;
            }
          }
        }
        if (nearestBearTrack?.pos) {
          const desiredAngle = Math.atan2(
            nearestBearTrack.pos.y - unit.pos.y,
            nearestBearTrack.pos.x - unit.pos.x,
          );
          const curAngle = unit.ladarTargetAngle;
          if (curAngle === undefined || Math.abs(wrapSignedAngle(desiredAngle - curAngle)) > 0.1) {
            dispatch({ type: 'set_ladar', unitId: unit.id, angleRad: desiredAngle });
          }
        } else if (unit.ladarTargetAngle !== undefined) {
          dispatch({ type: 'set_ladar', unitId: unit.id, angleRad: null });
        }
      }

      // Launch recon/EW drone sparingly (1 per carrier per 300s) when enemy contacts appear
      if (
        cfg.weapons.droneCapacity > 0 &&
        snapshot.tracks.some((t) => t.confidence === 'confirmed' || t.confidence === 'uncertain')
      ) {
        const lastLaunch = this.lastDroneLaunchSecByUnit.get(unit.id) ?? -999;
        if (nowSec - lastLaunch >= 300) {
          const droneKind = unit.kind === 'recon_corvette' ? 'drone_recon' : 'drone_ew';
          if (dispatch({ type: 'launch_drone', unitId: unit.id, droneKind })) {
            this.lastDroneLaunchSecByUnit.set(unit.id, nowSec);
          }
        }
      }
    }

    // Anti-missile interception on lockable incoming munition tracks
    const munTracks = snapshot.tracks.filter(
      (t) =>
        t.suspectedKind === 'munition' &&
        (t.confidence === 'confirmed' || t.confidence === 'uncertain') &&
        t.pos !== undefined,
    );
    for (const munTrack of munTracks) {
      const lastIntercept = this.lastMunitionInterceptSec.get(munTrack.trackId) ?? -999;
      if (nowSec - lastIntercept < 12) {
        continue;
      }
      const defender = shooters.find((s) => s.ammoStock >= 1);
      if (!defender) {
        break;
      }
      if (
        dispatch({
          type: 'fire_munition',
          unitId: defender.id,
          targetTrackId: munTrack.trackId,
          profileId: 'light_interceptor',
          count: 1,
          coldCoast: false,
        })
      ) {
        this.lastMunitionInterceptSec.set(munTrack.trackId, nowSec);
        defender.ammoStock = Math.max(0, defender.ammoStock - 1);
      }
    }

    // Offensive BVR strikes against lockable enemy ship / freighter / station tracks
    const targetTracks = snapshot.tracks.filter(
      (t) =>
        t.suspectedKind !== 'munition' &&
        (t.confidence === 'confirmed' || t.confidence === 'uncertain') &&
        t.pos !== undefined,
    );
    if (targetTracks.length === 0) {
      return;
    }

    for (const shooter of shooters) {
      if (shooter.kind === 'home_base' || shooter.ammoStock <= 0) {
        continue;
      }
      const lastFire = this.lastFireSecByUnit.get(shooter.id) ?? -999;
      if (nowSec - lastFire < 18) {
        continue;
      }

      let bestTrack: SensorTrack | undefined;
      let bestDist = 0.45;
      for (const trk of targetTracks) {
        const d = Math.hypot(trk.pos!.x - shooter.pos.x, trk.pos!.y - shooter.pos.y);
        if (d <= bestDist) {
          bestDist = d;
          bestTrack = trk;
        }
      }
      if (!bestTrack) {
        continue;
      }

      const useTorpedo = shooter.kind === 'raider' || shooter.kind === 'cruiser';
      if (
        dispatch({
          type: 'fire_munition',
          unitId: shooter.id,
          targetTrackId: bestTrack.trackId,
          profileId: useTorpedo ? 'heavy_torpedo' : 'light_interceptor',
          count: 1,
          coldCoast: useTorpedo,
        })
      ) {
        this.lastFireSecByUnit.set(shooter.id, nowSec);
      }
    }
  }

  private runEscortBindingRules(
    snapshot: FactionSnapshot,
    dispatch: (cmd: PlayerCommand) => boolean,
  ): void {
    const livingIds = new Set(snapshot.ownUnits.filter((u) => u.hp > 0).map((u) => u.id));
    const frigates = snapshot.ownUnits.filter(
      (u) => u.hp > 0 && u.kind === 'escort_frigate',
    );
    const alreadyAssigned = new Set(snapshot.routes.flatMap((r) => r.escortUnitIds));
    const shouldPausePropellant =
      snapshot.resources.propellant >= 260 && snapshot.resources.ore < 450;
    const shouldResumePropellant = snapshot.resources.propellant < 140;

    for (const route of snapshot.routes) {
      if (route.resource === 'propellant') {
        if (shouldPausePropellant && !route.paused) {
          dispatch({
            type: 'update_route',
            routeId: route.id,
            patch: { paused: true },
          });
        } else if (shouldResumePropellant && route.paused) {
          dispatch({
            type: 'update_route',
            routeId: route.id,
            patch: { paused: false },
          });
        }
      }

      const aliveEscorts = route.escortUnitIds.filter((id) => livingIds.has(id));
      if (aliveEscorts.length !== route.escortUnitIds.length) {
        dispatch({
          type: 'update_route',
          routeId: route.id,
          patch: { escortUnitIds: aliveEscorts },
        });
        continue;
      }

      if (aliveEscorts.length === 0 && frigates.length > 0) {
        const freeFrigate = frigates.find((f) => !alreadyAssigned.has(f.id));
        if (freeFrigate) {
          alreadyAssigned.add(freeFrigate.id);
          dispatch({
            type: 'update_route',
            routeId: route.id,
            patch: { escortUnitIds: [freeFrigate.id] },
          });
        }
      }
    }
  }

  private runPatrolAndManeuverRules(
    snapshot: FactionSnapshot,
    dispatch: (cmd: PlayerCommand) => boolean,
  ): void {
    const nowSec = snapshot.gameTimeSec;
    const homeBase = snapshot.ownUnits.find((u) => u.kind === 'home_base' && u.hp > 0);
    if (!homeBase) {
      return;
    }

    const enemyCorridorBody = this.faction === 'earth' ? 'vesta' : 'venus';
    const eros = snapshot.celestials.find((c) => c.id === 'eros');

    for (const unit of snapshot.ownUnits) {
      if (
        unit.hp <= 0 ||
        unit.subsystems.propulsion === 'offline' ||
        unit.deltaV <= 0.001 ||
        unit.plannedBurns.length > 0
      ) {
        continue;
      }

      if (
        unit.kind !== 'raider' &&
        unit.kind !== 'cruiser' &&
        unit.kind !== 'recon_corvette'
      ) {
        continue;
      }

      const lastMan = this.lastManeuverSecByUnit.get(unit.id) ?? -999;

      // Low fuel -> return to home base to refuel
      if (unit.deltaV < unit.maxDeltaV * 0.28) {
        this.dispatchedPatrolByUnit.delete(unit.id);
        if (nowSec - lastMan < 75) {
          continue;
        }
        const distHome = Math.hypot(unit.pos.x - homeBase.pos.x, unit.pos.y - homeBase.pos.y);
        if (distHome > 0.06) {
          this.lastManeuverSecByUnit.set(unit.id, nowSec);
          dispatch({
            type: 'plan_intercept',
            unitId: unit.id,
            targetRefId: homeBase.id,
            mode: 'fuel',
          });
        }
        continue;
      }

      if (nowSec - lastMan < 75 || this.dispatchedPatrolByUnit.has(unit.id)) {
        continue;
      }

      // Dispatch patrol / raiding mission toward Eros or enemy shipping corridor
      const targetBodyId =
        unit.kind === 'raider' && this.patrolToggle % 2 === 1 ? enemyCorridorBody : 'eros';
      this.patrolToggle += 1;

      if (eros && targetBodyId === 'eros') {
        const distEros = Math.hypot(unit.pos.x - eros.pos.x, unit.pos.y - eros.pos.y);
        if (distEros <= 0.14) {
          this.dispatchedPatrolByUnit.add(unit.id);
          this.lastManeuverSecByUnit.set(unit.id, nowSec);
          continue;
        }
      }

      this.lastManeuverSecByUnit.set(unit.id, nowSec);
      const mode = unit.kind === 'raider' && lastMan < 0 ? 'stealth' : 'fuel';
      const ok = dispatch({
        type: 'plan_intercept',
        unitId: unit.id,
        targetRefId: targetBodyId,
        mode,
      });
      if (ok) {
        this.dispatchedPatrolByUnit.add(unit.id);
      }
    }
  }
}

export interface RuleAiSystemOptions extends RuleAiOptions {
  factions: readonly FactionId[];
}

/**
 * Creates a `post_sensor` SimulationLoop system hook running SimpleRuleAiController
 * for one or both factions (single-player vs AI or automated soak tests).
 */
export function createRuleAiTickSystem(options: RuleAiSystemOptions): TickSystemHook & {
  getController: (faction: FactionId) => SimpleRuleAiController | undefined;
} {
  const controllers = new Map<FactionId, SimpleRuleAiController>();
  for (const faction of options.factions) {
    controllers.set(faction, new SimpleRuleAiController(faction, options));
  }

  const hook: TickSystemHook & {
    getController: (faction: FactionId) => SimpleRuleAiController | undefined;
  } = ({ world }) => {
    for (const controller of controllers.values()) {
      controller.step(world);
    }
  };
  hook.getController = (faction: FactionId) => controllers.get(faction);
  return hook;
}
