import { PROTOCOL_VERSION, SIM_TICK_RATE_HZ } from '@space-war/shared';
import { describe, expect, it } from 'vitest';
import { SimulationLoop } from '../src/engine/simulationLoop.js';
import {
  DEFAULT_LIVE_TIME_SCALE,
  createSpaceWarServer,
  getHealthPayload,
} from '../src/server.js';

describe('@space-war/server scaffold', () => {
  it('builds health payload from shared protocol constants', () => {
    expect(getHealthPayload()).toEqual({
      status: 'ok',
      service: 'space-war-server',
      protocolVersion: PROTOCOL_VERSION,
      tickRateHz: SIM_TICK_RATE_HZ,
    });
  });

  it('defaults live servers to 0.5x timeScale, scales SimulationLoop ticks, and hosts AI rooms', async () => {
    expect(DEFAULT_LIVE_TIME_SCALE).toBe(0.5);

    const loop = new SimulationLoop(undefined, { timeScale: 0.5 });
    for (let i = 0; i < 10; i++) {
      loop.stepTick();
    }
    expect(loop.world.tick).toBe(10);
    expect(loop.world.gameTimeSec).toBeCloseTo(0.5, 6);

    const server = createSpaceWarServer({
      port: 0,
      roomManagerOptions: { autoStartLoop: false },
    });
    const aiRoom = server.roomManager.getOrCreateRoom('ai-smoke');
    expect(aiRoom.roomId).toBe('ai-smoke');
    await server.close();
  });
});
