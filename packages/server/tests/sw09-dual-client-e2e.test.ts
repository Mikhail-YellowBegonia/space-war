import {
  SOLAR_SYSTEM_BODIES,
  solveInterceptTransfer,
  type ClientMessage,
  type FactionSnapshot,
  type ServerMessage,
} from '@space-war/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createSpaceWarServer, type SpaceWarServer } from '../src/server.js';

interface TestWsClient {
  socket: WebSocket;
  messages: ServerMessage[];
  waitFor: <T extends ServerMessage['type']>(
    type: T,
    predicate?: (msg: Extract<ServerMessage, { type: T }>) => boolean,
    timeoutMs?: number,
  ) => Promise<Extract<ServerMessage, { type: T }>>;
  send: (msg: ClientMessage) => void;
  close: () => Promise<void>;
}

async function connectWsClient(url: string): Promise<TestWsClient> {
  const socket = new WebSocket(url);
  const messages: ServerMessage[] = [];

  socket.on('message', (raw) => {
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');
    messages.push(JSON.parse(text) as ServerMessage);
  });

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', (err) => reject(err));
  });

  return {
    socket,
    messages,
    waitFor<T extends ServerMessage['type']>(
      type: T,
      predicate?: (msg: Extract<ServerMessage, { type: T }>) => boolean,
      timeoutMs = 3000,
    ): Promise<Extract<ServerMessage, { type: T }>> {
      const findMatch = () =>
        messages.find(
          (m): m is Extract<ServerMessage, { type: T }> =>
            m.type === type && (!predicate || predicate(m as Extract<ServerMessage, { type: T }>)),
        );

      const existing = findMatch();
      if (existing) {
        return Promise.resolve(existing);
      }

      return new Promise<Extract<ServerMessage, { type: T }>>((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.off('message', onMsg);
          reject(new Error(`Timed out waiting for message ${type}`));
        }, timeoutMs);

        const onMsg = () => {
          const match = findMatch();
          if (match) {
            clearTimeout(timer);
            socket.off('message', onMsg);
            resolve(match);
          }
        };
        socket.on('message', onMsg);
      });
    },
    send(msg: ClientMessage) {
      socket.send(JSON.stringify(msg));
    },
    close() {
      return new Promise((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        socket.once('close', () => resolve());
        socket.close();
      });
    },
  };
}

describe('SW-09 dual-client end-to-end Eros intercept sync', () => {
  let activeServer: SpaceWarServer | null = null;
  const openClients: TestWsClient[] = [];

  afterEach(async () => {
    for (const client of openClients.splice(0)) {
      await client.close();
    }
    if (activeServer) {
      await activeServer.close();
      activeServer = null;
    }
  });

  it('connects Earth & Mars over live WebSocket, maneuvers toward Eros within <0.5% error, and runs 10min without desync', async () => {
    activeServer = createSpaceWarServer({
      port: 0,
      host: '127.0.0.1',
      roomManagerOptions: { autoStartLoop: false },
    });
    const bound = await activeServer.start();
    const wsUrl = `ws://${bound.host}:${bound.port}`;

    const earthClient = await connectWsClient(wsUrl);
    const marsClient = await connectWsClient(wsUrl);
    openClients.push(earthClient, marsClient);

    await earthClient.waitFor('hello');
    await marsClient.waitFor('hello');

    earthClient.send({ type: 'join_room', roomId: 'e2e-eros', preferredFaction: 'earth' });
    marsClient.send({ type: 'join_room', roomId: 'e2e-eros', preferredFaction: 'mars' });

    const earthJoined = await earthClient.waitFor('room_joined');
    const marsJoined = await marsClient.waitFor('room_joined');
    expect(earthJoined.faction).toBe('earth');
    expect(marsJoined.faction).toBe('mars');

    const earthSnap0 = (await earthClient.waitFor('snapshot')).snapshot;
    const marsSnap0 = (await marsClient.waitFor('snapshot')).snapshot;

    // Fog-of-war check over live WS
    expect(earthSnap0.ownUnits.every((u) => u.faction === 'earth')).toBe(true);
    expect(marsSnap0.ownUnits.every((u) => u.faction === 'mars')).toBe(true);

    // Client-side predicted intercept plans to 433 Eros
    const earthCruiser0 = earthSnap0.ownUnits.find((u) => u.id === 'earth-cruiser-1')!;
    const marsCruiser0 = marsSnap0.ownUnits.find((u) => u.id === 'mars-cruiser-1')!;
    const earthPredicted = solveInterceptTransfer(
      { unit: earthCruiser0, nowSec: earthSnap0.gameTimeSec, celestialBodies: SOLAR_SYSTEM_BODIES },
      'eros',
    ).fast;
    const marsPredicted = solveInterceptTransfer(
      { unit: marsCruiser0, nowSec: marsSnap0.gameTimeSec, celestialBodies: SOLAR_SYSTEM_BODIES },
      'eros',
    ).fast;

    expect(earthPredicted.feasible).toBe(true);
    expect(marsPredicted.feasible).toBe(true);

    // Issue both maneuvers via live WebSocket
    earthClient.send({
      type: 'command',
      clientSeq: 1,
      command: {
        type: 'plan_intercept',
        unitId: 'earth-cruiser-1',
        targetRefId: 'eros',
        mode: 'fast',
      },
    });
    marsClient.send({
      type: 'command',
      clientSeq: 1,
      command: {
        type: 'plan_intercept',
        unitId: 'mars-cruiser-1',
        targetRefId: 'eros',
        mode: 'fast',
      },
    });

    const ackEarth = await earthClient.waitFor('command_ack', (m) => m.clientSeq === 1);
    const ackMars = await marsClient.waitFor('command_ack', (m) => m.clientSeq === 1);
    expect(ackEarth.accepted).toBe(true);
    expect(ackMars.accepted).toBe(true);

    // Advance 6000 ticks (10 minutes @ 10Hz) to verify sustained stability & orbital accuracy
    const room = activeServer.roomManager.getRoom('e2e-eros')!;
    const checkTick = 100; // t = 10.0 s (post-departure transfer leg)
    for (let t = 0; t < checkTick; t++) {
      room.loop.stepTick();
    }
    activeServer.roomManager.broadcastRoomSnapshots('e2e-eros');

    const earthSnapAt10s = (
      await earthClient.waitFor('snapshot', (m) => m.snapshot.tick === checkTick)
    ).snapshot;
    const marsSnapAt10s = (
      await marsClient.waitFor('snapshot', (m) => m.snapshot.tick === checkTick)
    ).snapshot;

    const earthCruiser10s = earthSnapAt10s.ownUnits.find((u) => u.id === 'earth-cruiser-1')!;
    const marsCruiser10s = marsSnapAt10s.ownUnits.find((u) => u.id === 'mars-cruiser-1')!;

    const expectedEarthTransferOrbit = earthPredicted.previewOrbitSegments[0]!;
    const expectedMarsTransferOrbit = marsPredicted.previewOrbitSegments[0]!;

    const earthSemiMajorRelErr =
      Math.abs(earthCruiser10s.orbit.a - expectedEarthTransferOrbit.a) /
      expectedEarthTransferOrbit.a;
    const marsSemiMajorRelErr =
      Math.abs(marsCruiser10s.orbit.a - expectedMarsTransferOrbit.a) /
      expectedMarsTransferOrbit.a;

    expect(earthSemiMajorRelErr).toBeLessThan(0.005);
    expect(marsSemiMajorRelErr).toBeLessThan(0.005);

    // Continue running out to 6000 ticks (10 full game minutes) without crashes or desync
    for (let t = checkTick; t < 6000; t++) {
      room.loop.stepTick();
    }
    activeServer.roomManager.broadcastRoomSnapshots('e2e-eros');

    const earthSnap10m: FactionSnapshot = (
      await earthClient.waitFor('snapshot', (m) => m.snapshot.tick === 6000)
    ).snapshot;
    const marsSnap10m: FactionSnapshot = (
      await marsClient.waitFor('snapshot', (m) => m.snapshot.tick === 6000)
    ).snapshot;

    expect(earthSnap10m.gameTimeSec).toBeCloseTo(600, 6);
    expect(marsSnap10m.gameTimeSec).toBeCloseTo(600, 6);
    expect(earthSnap10m.ownUnits.every((u) => Number.isFinite(u.pos.x) && Number.isFinite(u.pos.y))).toBe(true);
    expect(marsSnap10m.ownUnits.every((u) => Number.isFinite(u.pos.x) && Number.isFinite(u.pos.y))).toBe(true);
  });
});
