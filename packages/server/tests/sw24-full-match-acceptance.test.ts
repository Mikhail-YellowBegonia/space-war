import {
  SOLAR_SYSTEM_BODIES,
  UNIT_CONFIGS,
  WONDER_CONFIG,
  type ClientMessage,
  type ServerMessage,
} from '@space-war/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  HeadlessMatchRunner,
  createFiveMinuteStartupWorldState,
  createRuleAiTickSystem,
  createSpaceWarServer,
  type SpaceWarServer,
} from '../src/index.js';

interface LiveWsClient {
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

async function connectClient(url: string): Promise<LiveWsClient> {
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
      const hit = findMatch();
      if (hit) {
        return Promise.resolve(hit);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.off('message', onMsg);
          reject(new Error(`Timed out waiting for ${type}`));
        }, timeoutMs);
        const onMsg = () => {
          const m = findMatch();
          if (m) {
            clearTimeout(timer);
            socket.off('message', onMsg);
            resolve(m);
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

describe('SW-24 45-minute full-match acceptance, live PvP soak, and V0.1 verification', () => {
  let server: SpaceWarServer | null = null;
  const openClients: LiveWsClient[] = [];

  afterEach(async () => {
    for (const c of openClients.splice(0)) {
      await c.close();
    }
    if (server) {
      await server.close();
      server = null;
    }
  });

  it(
    'validates 5-minute startup strike and full <=45-minute decisive match victory under AI soak',
    () => {
      const runner = new HeadlessMatchRunner(createFiveMinuteStartupWorldState());
      runner.loop.registerSystem(
        createRuleAiTickSystem({
          factions: ['earth', 'mars'],
          decisionIntervalSec: 4.0,
        }),
        'post_sensor',
      );

      const world = runner.getWorldState();

      // Phase 1: First 5 minutes (3000 ticks = 300s) -> startup builds & interplanetary maneuver
      runner.runTicks(3000);
      expect(world.gameTimeSec).toBeCloseTo(300, 4);

      const earthWarships5m = [...world.units.values()].filter(
        (u) =>
          u.faction === 'earth' &&
          (u.kind === 'raider' || u.kind === 'escort_frigate' || u.kind === 'cruiser'),
      );
      const marsWarships5m = [...world.units.values()].filter(
        (u) =>
          u.faction === 'mars' &&
          (u.kind === 'raider' || u.kind === 'escort_frigate' || u.kind === 'cruiser'),
      );
      expect(earthWarships5m.length).toBeGreaterThanOrEqual(1);
      expect(marsWarships5m.length).toBeGreaterThanOrEqual(1);
      expect(
        [...earthWarships5m, ...marsWarships5m].some(
          (u) => u.deltaV < UNIT_CONFIGS[u.kind].maxDeltaV,
        ),
      ).toBe(true);

      // Phase 2: Continue up to 45 minutes total (27000 ticks = 2700s) until decisive winner
      for (let tick = 3000; tick < 27000 && world.winner === null; tick++) {
        runner.stepTick();
      }

      expect(world.winner).not.toBeNull();
      expect(world.gameTimeSec).toBeLessThanOrEqual(2700);
      expect(
        [...world.units.values()].every((u) => Number.isFinite(u.pos.x) && Number.isFinite(u.pos.y)),
      ).toBe(true);

      // Winner achieved either via 16/16 wonder stabilization or enemy home base destruction
      const winner = world.winner!;
      const loser = winner === 'earth' ? 'mars' : 'earth';
      const winnerSlotsComplete = world.factions[winner].wonder.filter(
        (s) => s.status === 'complete',
      ).length;
      const loserHome = world.units.get(`${loser}-home-base`);
      expect(winnerSlotsComplete === WONDER_CONFIG.slotCount || (loserHome?.hp ?? 0) <= 0).toBe(true);
      expect(SOLAR_SYSTEM_BODIES.length).toBe(11);
    },
    25_000,
  );

  it('completes a dual-client WebSocket match across logistics, maneuvers, reconnect, and wonder victory', async () => {
    server = createSpaceWarServer({
      port: 0,
      host: '127.0.0.1',
      roomManagerOptions: { autoStartLoop: false },
    });
    const bound = await server.start();
    const wsUrl = `ws://${bound.host}:${bound.port}`;

    const earthClient = await connectClient(wsUrl);
    const marsClient = await connectClient(wsUrl);
    openClients.push(earthClient, marsClient);

    await earthClient.waitFor('hello');
    await marsClient.waitFor('hello');

    earthClient.send({ type: 'join_room', roomId: 'v01-pvp', preferredFaction: 'earth' });
    marsClient.send({ type: 'join_room', roomId: 'v01-pvp', preferredFaction: 'mars' });

    const earthJoined = await earthClient.waitFor('room_joined');
    await marsClient.waitFor('room_joined');

    // Both clients issue live logistics & orbital commands
    earthClient.send({
      type: 'command',
      clientSeq: 1,
      command: {
        type: 'update_route',
        routeId: 'route-earth-venus-ore',
        patch: { detourWaypoint: { x: 1.08, y: 0.35 } },
      },
    });
    earthClient.send({
      type: 'command',
      clientSeq: 2,
      command: {
        type: 'queue_build',
        kind: 'raider',
      },
    });
    marsClient.send({
      type: 'command',
      clientSeq: 1,
      command: {
        type: 'plan_intercept',
        unitId: 'mars-raider-1',
        targetRefId: 'eros',
        mode: 'stealth',
      },
    });

    expect((await earthClient.waitFor('command_ack', (m) => m.clientSeq === 1)).accepted).toBe(true);
    expect((await earthClient.waitFor('command_ack', (m) => m.clientSeq === 2)).accepted).toBe(true);
    expect((await marsClient.waitFor('command_ack', (m) => m.clientSeq === 1)).accepted).toBe(true);

    // Step simulation & test mid-match disconnect + reconnect via playerToken
    const room = server.roomManager.getRoom('v01-pvp')!;
    for (let i = 0; i < 600; i++) {
      room.loop.stepTick();
    }
    await earthClient.close();

    const earthReconnected = await connectClient(wsUrl);
    openClients.push(earthReconnected);
    await earthReconnected.waitFor('hello');
    earthReconnected.send({
      type: 'join_room',
      roomId: 'v01-pvp',
      playerToken: earthJoined.playerToken,
    });
    const rejoinedMsg = await earthReconnected.waitFor('room_joined');
    expect(rejoinedMsg.faction).toBe('earth');
    const snapAfterRejoin = (await earthReconnected.waitFor('snapshot')).snapshot;
    expect(snapAfterRejoin.tick).toBe(600);
    // Built raider finished during 60s
    expect(snapAfterRejoin.ownUnits.some((u) => u.kind === 'raider')).toBe(true);
    // Fog-of-war isolation intact
    expect(snapAfterRejoin.ownUnits.every((u) => u.faction === 'earth')).toBe(true);

    // Advance Earth wonder to final stage over WebSocket & verify synchronized victory snapshot
    const w = room.loop.world;
    w.factions.earth.resources.ore = 1000;
    for (let i = 0; i < 15; i++) {
      w.factions.earth.wonder[i]!.status = 'complete';
      w.factions.earth.wonder[i]!.progressOre = WONDER_CONFIG.orePerSlot;
    }
    w.factions.earth.wonder[15]!.status = 'building';
    w.factions.earth.wonder[15]!.progressOre = WONDER_CONFIG.orePerSlot - 1;

    for (let i = 0; i < 650; i++) {
      room.loop.stepTick();
    }
    server.roomManager.broadcastRoomSnapshots('v01-pvp');

    const earthFinal = (
      await earthReconnected.waitFor('snapshot', (m) => m.snapshot.winner !== null)
    ).snapshot;
    const marsFinal = (await marsClient.waitFor('snapshot', (m) => m.snapshot.winner !== null))
      .snapshot;

    expect(earthFinal.winner).toBe('earth');
    expect(marsFinal.winner).toBe('earth');
  });
});
