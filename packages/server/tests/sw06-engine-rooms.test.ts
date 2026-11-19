import { PROTOCOL_VERSION, type ServerMessage } from '@space-war/shared';
import { describe, expect, it } from 'vitest';
import {
  HeadlessMatchRunner,
  RoomManager,
  type ClientConnection,
} from '../src/index.js';

interface MockClient {
  conn: ClientConnection;
  messages: ServerMessage[];
}

function createMockClient(id: string): MockClient {
  const messages: ServerMessage[] = [];
  return {
    conn: {
      id,
      send: (msg) => {
        messages.push(msg);
      },
    },
    messages,
  };
}

describe('SW-06 10Hz SimulationLoop, HeadlessMatchRunner, and 2P RoomManager', () => {
  it('runs HeadlessMatchRunner maneuvers, updates unit orbits, and isolates faction snapshots', () => {
    const runner = new HeadlessMatchRunner();
    const initialEarth = runner.getSnapshot('earth');
    const initialMars = runner.getSnapshot('mars');

    // Fog-of-war red line: snapshots never leak enemy entities in ownUnits
    expect(initialEarth.ownUnits.every((u) => u.faction === 'earth')).toBe(true);
    expect(initialMars.ownUnits.every((u) => u.faction === 'mars')).toBe(true);
    expect(initialEarth.ownUnits.some((u) => u.id.startsWith('mars-'))).toBe(false);
    expect(initialMars.ownUnits.some((u) => u.id.startsWith('earth-'))).toBe(false);

    // Reject cross-faction command spoofing
    const spoofed = runner.submitCommand('earth', {
      type: 'plan_orbit_insertion',
      unitId: 'mars-raider-1',
      targetOrbit: { a: 1.32, e: 0.1, omega: 0, meanAnomaly0: 0, epochSec: 0 },
      mode: 'fuel',
    });
    expect(spoofed.accepted).toBe(false);

    // Issue valid orbit insertion and intercept commands for Earth & Mars
    const earthCmd = runner.submitCommand('earth', {
      type: 'plan_orbit_insertion',
      unitId: 'earth-raider-1',
      targetOrbit: { a: 1.32, e: 0.12, omega: 0.3, meanAnomaly0: 0, epochSec: 0 },
      mode: 'fast',
    });
    expect(earthCmd.accepted).toBe(true);

    const marsCmd = runner.submitCommand('mars', {
      type: 'plan_intercept',
      unitId: 'mars-cruiser-1',
      targetRefId: 'eros',
      mode: 'fuel',
    });
    expect(marsCmd.accepted).toBe(true);

    const earthRaiderBefore = initialEarth.ownUnits.find((u) => u.id === 'earth-raider-1')!;
    runner.runTicks(20);

    const afterEarth = runner.getSnapshot('earth');
    expect(afterEarth.tick).toBe(20);
    expect(afterEarth.gameTimeSec).toBeCloseTo(2.0, 6);

    const earthRaiderAfter = afterEarth.ownUnits.find((u) => u.id === 'earth-raider-1')!;
    expect(earthRaiderAfter.deltaV).toBeLessThan(earthRaiderBefore.deltaV);
    expect(earthRaiderAfter.orbit.a).not.toBeCloseTo(earthRaiderBefore.orbit.a, 4);
  });

  it('connects two clients to the same room, syncs snapshots after maneuvers, and supports token reconnect', () => {
    const rooms = new RoomManager({ autoStartLoop: false });
    const clientA = createMockClient('conn-a');
    const clientB = createMockClient('conn-b');

    rooms.handleConnect(clientA.conn);
    rooms.handleConnect(clientB.conn);

    expect(clientA.messages[0]).toMatchObject({ type: 'hello', protocolVersion: PROTOCOL_VERSION });
    expect(clientB.messages[0]).toMatchObject({ type: 'hello', protocolVersion: PROTOCOL_VERSION });

    rooms.handleMessage(clientA.conn, JSON.stringify({
      type: 'join_room',
      roomId: 'match-1',
      preferredFaction: 'earth',
    }));
    rooms.handleMessage(clientB.conn, JSON.stringify({
      type: 'join_room',
      roomId: 'match-1',
      preferredFaction: 'mars',
    }));

    const joinedA = clientA.messages.find((m) => m.type === 'room_joined');
    const joinedB = clientB.messages.find((m) => m.type === 'room_joined');
    expect(joinedA).toMatchObject({ type: 'room_joined', roomId: 'match-1', faction: 'earth' });
    expect(joinedB).toMatchObject({ type: 'room_joined', roomId: 'match-1', faction: 'mars' });
    const tokenA = (joinedA as Extract<ServerMessage, { type: 'room_joined' }>).playerToken;

    // 3rd client rejected when room is full
    const clientC = createMockClient('conn-c');
    rooms.handleConnect(clientC.conn);
    rooms.handleMessage(clientC.conn, { type: 'join_room', roomId: 'match-1' });
    expect(clientC.messages.find((m) => m.type === 'error')).toMatchObject({
      type: 'error',
      code: 'ROOM_FULL',
    });

    // Earth player issues a maneuver command
    rooms.handleMessage(clientA.conn, {
      type: 'command',
      clientSeq: 7,
      command: {
        type: 'plan_intercept',
        unitId: 'earth-raider-1',
        targetRefId: 'eros',
        mode: 'fast',
      },
    });
    expect(clientA.messages.find((m) => m.type === 'command_ack')).toEqual({
      type: 'command_ack',
      clientSeq: 7,
      accepted: true,
    });

    // Step room 5 ticks and confirm both clients receive synchronized snapshots
    for (let i = 0; i < 5; i++) {
      rooms.stepRoom('match-1');
    }

    const snapsA = clientA.messages.filter(
      (m): m is Extract<ServerMessage, { type: 'snapshot' }> => m.type === 'snapshot',
    );
    const snapsB = clientB.messages.filter(
      (m): m is Extract<ServerMessage, { type: 'snapshot' }> => m.type === 'snapshot',
    );
    expect(snapsA.at(-1)?.snapshot.tick).toBe(5);
    expect(snapsB.at(-1)?.snapshot.tick).toBe(5);
    expect(snapsA.at(-1)?.snapshot.ownUnits.some((u) => u.faction === 'mars')).toBe(false);
    expect(snapsB.at(-1)?.snapshot.ownUnits.some((u) => u.faction === 'earth')).toBe(false);

    // Simulate disconnect and token reconnect for Earth player
    rooms.handleDisconnect(clientA.conn);
    const clientA2 = createMockClient('conn-a-reconnected');
    rooms.handleConnect(clientA2.conn);
    rooms.handleMessage(clientA2.conn, {
      type: 'join_room',
      roomId: 'match-1',
      playerToken: tokenA,
    });

    const rejoined = clientA2.messages.find((m) => m.type === 'room_joined');
    expect(rejoined).toMatchObject({
      type: 'room_joined',
      roomId: 'match-1',
      faction: 'earth',
      playerToken: tokenA,
    });
    const reconnectedSnap = clientA2.messages.find(
      (m): m is Extract<ServerMessage, { type: 'snapshot' }> => m.type === 'snapshot',
    );
    expect(reconnectedSnap?.snapshot.tick).toBe(5);

    // Ping/pong health check
    rooms.handleMessage(clientA2.conn, { type: 'ping', sentAtMs: 12345 });
    expect(clientA2.messages.find((m) => m.type === 'pong')).toMatchObject({
      type: 'pong',
      sentAtMs: 12345,
    });

    rooms.stopAll();
  });
});
