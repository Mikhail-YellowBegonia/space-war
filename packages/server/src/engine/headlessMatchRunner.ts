import type { FactionId, FactionSnapshot, PlayerCommand } from '@space-war/shared';
import type { CommandValidationResult } from './commandPipeline.js';
import { SimulationLoop, type SimulationLoopOptions } from './simulationLoop.js';
import { createInitialWorldState, type WorldState } from './worldState.js';

interface ScheduledCommand {
  atTick: number;
  faction: FactionId;
  command: PlayerCommand;
}

/**
 * Deterministic headless match runner for automated simulation verification and soak tests
 * without any WebSocket or browser dependencies.
 */
export class HeadlessMatchRunner {
  public readonly loop: SimulationLoop;
  private readonly scheduled: ScheduledCommand[] = [];

  constructor(
    initialWorld: WorldState = createInitialWorldState(),
    options: SimulationLoopOptions = {},
  ) {
    this.loop = new SimulationLoop(initialWorld, options);
  }

  public submitCommand(faction: FactionId, command: PlayerCommand): CommandValidationResult {
    return this.loop.submitCommand(faction, command);
  }

  public scheduleCommand(atTick: number, faction: FactionId, command: PlayerCommand): void {
    this.scheduled.push({ atTick, faction, command });
  }

  public stepTick(): CommandValidationResult[] {
    const dueResults: CommandValidationResult[] = [];
    const currentTick = this.loop.world.tick;
    const remaining: ScheduledCommand[] = [];

    for (const item of this.scheduled) {
      if (item.atTick <= currentTick) {
        dueResults.push(this.loop.submitCommand(item.faction, item.command));
      } else {
        remaining.push(item);
      }
    }
    this.scheduled.length = 0;
    this.scheduled.push(...remaining);

    this.loop.stepTick();
    return dueResults;
  }

  public runTicks(count: number): void {
    for (let i = 0; i < count; i++) {
      this.stepTick();
    }
  }

  public runForSeconds(durationSec: number): void {
    const ticks = Math.max(0, Math.round(durationSec * this.loop.tickRateHz));
    this.runTicks(ticks);
  }

  public getSnapshot(faction: FactionId): FactionSnapshot {
    return this.loop.getSnapshot(faction);
  }

  public getWorldState(): WorldState {
    return this.loop.world;
  }
}
