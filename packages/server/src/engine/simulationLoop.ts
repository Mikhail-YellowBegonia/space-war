import {
  PROPULSION_CONFIGS,
  SIM_TICK_RATE_HZ,
  advanceUnitOrbit,
  type FactionId,
  type FactionSnapshot,
  type PlayerCommand,
} from '@space-war/shared';
import { applyPlayerCommand, type CommandValidationResult } from './commandPipeline.js';
import { buildFactionSnapshot, createInitialWorldState, type WorldState } from './worldState.js';
import { createThermalTickSystem } from '../systems/thermal.js';
import { createEwTickSystem } from '../systems/ew.js';
import { createMunitionTickSystem } from '../systems/munitions.js';
import {
  applyMunitionWarheadImpact,
  createCombatTickSystem,
  evaluateCiwsIntercept,
  isUnitThermallyLockedOut,
} from '../systems/combat.js';
import { createSensorTickSystem } from '../systems/sensors.js';
import { createLogisticsTickSystem } from '../systems/logistics.js';

export interface TickSystemContext {
  world: WorldState;
  dtSec: number;
  usedDeltaVByUnit: ReadonlyMap<string, number>;
}

export type TickSystemHook = (ctx: TickSystemContext) => void;

export interface SimulationLoopOptions {
  tickRateHz?: number;
  systems?: TickSystemHook[];
  onTick?: (world: WorldState) => void;
}

/**
 * Authoritative 10Hz fixed-timestep simulation loop managing unit orbital kinematics,
 * command validation/application, system hooks, and per-faction snapshot extraction.
 */
export class SimulationLoop {
  public readonly world: WorldState;
  public readonly tickRateHz: number;
  public readonly dtSec: number;
  public readonly irByUnit = new Map<string, number>();
  private readonly systems: TickSystemHook[];
  private postSensorCount = 1;
  private readonly onTick?: (world: WorldState) => void;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    initialWorld: WorldState = createInitialWorldState(),
    options: SimulationLoopOptions = {},
  ) {
    this.world = initialWorld;
    this.tickRateHz = options.tickRateHz ?? SIM_TICK_RATE_HZ;
    this.dtSec = 1 / this.tickRateHz;
    this.systems = [
      createEwTickSystem(),
      createMunitionTickSystem({
        ciwsIntercept: evaluateCiwsIntercept,
        warheadImpact: applyMunitionWarheadImpact,
      }),
      createCombatTickSystem(),
      ...(options.systems ?? []),
      createThermalTickSystem(this.irByUnit),
      createSensorTickSystem(this.irByUnit),
      createLogisticsTickSystem(),
    ];
    this.onTick = options.onTick;
  }

  public getUnitIrSignature(unitId: string): number {
    return this.irByUnit.get(unitId) ?? 0;
  }

  public registerSystem(
    hook: TickSystemHook,
    phase: 'pre_thermal' | 'post_sensor' = 'pre_thermal',
  ): void {
    if (phase === 'post_sensor') {
      this.systems.push(hook);
      this.postSensorCount += 1;
      return;
    }
    const insertIdx = Math.max(0, this.systems.length - 2 - this.postSensorCount);
    this.systems.splice(insertIdx, 0, hook);
  }

  public submitCommand(faction: FactionId, command: PlayerCommand): CommandValidationResult {
    return applyPlayerCommand(this.world, faction, command);
  }

  public stepTick(): void {
    const prevTimeSec = this.world.gameTimeSec;
    this.world.vfxEvents = [];
    this.world.laserActiveUnitIds.clear();

    const usedDeltaVByUnit = new Map<string, number>();

    for (const [unitId, unit] of this.world.units.entries()) {
      const thermalLocked = isUnitThermallyLockedOut(unit);
      const orbitInput = thermalLocked ? { ...unit, deltaV: 0 } : unit;
      const result = advanceUnitOrbit(orbitInput, prevTimeSec, this.dtSec);
      const nextUnit = thermalLocked ? { ...result.unit, deltaV: unit.deltaV } : result.unit;
      this.world.units.set(unitId, nextUnit);

      if (result.usedDeltaV > 0) {
        usedDeltaVByUnit.set(unitId, result.usedDeltaV);
        const irFactor = PROPULSION_CONFIGS[unit.propulsion].irFactor;
        this.world.vfxEvents.push({
          kind: 'burn_flash',
          from: { ...nextUnit.pos },
          intensity: Math.min(1, Math.max(0.05, irFactor / 100)),
        });
      }
    }

    this.world.tick += 1;
    this.world.gameTimeSec = Number((this.world.tick * this.dtSec).toFixed(6));

    for (const system of this.systems) {
      system({
        world: this.world,
        dtSec: this.dtSec,
        usedDeltaVByUnit,
      });
    }

    this.onTick?.(this.world);
  }

  public getSnapshot(faction: FactionId): FactionSnapshot {
    return buildFactionSnapshot(this.world, faction);
  }

  public start(): void {
    if (this.timer !== null) {
      return;
    }
    const intervalMs = Math.max(10, Math.round(1000 / this.tickRateHz));
    this.timer = setInterval(() => {
      this.stepTick();
    }, intervalMs);
  }

  public stop(): void {
    if (this.timer === null) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  public isRunning(): boolean {
    return this.timer !== null;
  }
}
