import { PROTOCOL_VERSION, SIM_TICK_RATE_HZ } from '@space-war/shared';
import { describe, expect, it } from 'vitest';
import { createSpaceWarServer, getHealthPayload } from '../src/server.js';

describe('@space-war/server scaffold', () => {
  it('builds health payload from shared protocol constants', () => {
    expect(getHealthPayload()).toEqual({
      status: 'ok',
      service: 'space-war-server',
      protocolVersion: PROTOCOL_VERSION,
      tickRateHz: SIM_TICK_RATE_HZ,
    });
  });

  it('instantiates server without binding a listening socket', async () => {
    const server = createSpaceWarServer({ port: 0 });
    expect(typeof server.start).toBe('function');
    expect(typeof server.close).toBe('function');
    await server.close();
  });
});
