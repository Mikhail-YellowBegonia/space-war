import {
  PROTOCOL_VERSION,
  SOLAR_SYSTEM_BODIES,
  orbitToState,
  type ClientMessage,
  type FactionSnapshot,
  type KeplerOrbit,
  type ServerMessage,
} from '@space-war/shared';
import { describe, expect, it } from 'vitest';
import { OrbitInteractionManager } from '../src/interaction/index.js';
import { WsWorldProvider, type WebSocketLike } from '../src/net/index.js';

class FakeWebSocket implements WebSocketLike {
  readyState = 0;
  readonly sentMessages: ClientMessage[] = [];
  private readonly listeners = new Map<string, Set<(ev: unknown) => void>>();

  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (ev: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (ev: unknown) => void,
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sentMessages.push(JSON.parse(data) as ClientMessage);
  }

  close(): void {
    this.readyState = 3;
  }

  emitOpen(): void {
    this.readyState = 1;
    this.dispatch('open', {});
  }

  emitServerMessage(msg: ServerMessage): void {
    this.dispatch('message', { data: JSON.stringify(msg) });
  }

  emitClose(): void {
    this.readyState = 3;
    this.dispatch('close', {});
  }

  private dispatch(type: string, event: unknown): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const fn of set) {
      fn(event);
    }
  }
}

function makeSampleSnapshot(gameTimeSec: number, orbit: KeplerOrbit): FactionSnapshot {
  const state = orbitToState(orbit, gameTimeSec);
  return {
    tick: Math.round(gameTimeSec * 10),
    gameTimeSec,
    faction: 'earth',
    resources: { ore: 300, propellant: 200 },
    freighterCap: 3,
    freightersInFlight: 0,
    celestials: SOLAR_SYSTEM_BODIES.map((b) => ({
      id: b.id,
      pos: b.orbit ? orbitToState(b.orbit, gameTimeSec).pos : { x: 0, y: 0 },
      vel: b.orbit ? orbitToState(b.orbit, gameTimeSec).vel : { x: 0, y: 0 },
    })),
    ownUnits: [
      {
        id: 'earth-raider-1',
        faction: 'earth',
        kind: 'raider',
        propulsion: 'chemical',
        pos: state.pos,
        vel: state.vel,
        orbit,
        hp: 280,
        maxHp: 280,
        subsystems: { propulsion: 'normal', sensors: 'normal', weapons: 'normal', thermal: 'normal' },
        deltaV: 0.018,
        maxDeltaV: 0.018,
        heat: 0,
        maxHeat: 220,
        radiatorsOpen: true,
        emconSilent: false,
        radarActive: false,
        jammerActive: false,
        ammoStock: 12,
        plannedBurns: [],
      },
    ],
    ownMunitions: [],
    tracks: [],
    routes: [],
    ownWonder: [],
    enemyWonderPublicProgress: 0,
    vfxEvents: [],
    winner: null,
  };
}

describe('SW-09 WsWorldProvider handshake, smoothing, and reconnect', () => {
  it('completes room_joined handshake, acknowledges commands, and integrates with OrbitInteractionManager', async () => {
    const sockets: FakeWebSocket[] = [];
    let currentMs = 1000;

    const provider = new WsWorldProvider({
      url: 'ws://localhost:3001',
      roomId: 'room-alpha',
      preferredFaction: 'earth',
      reconnectDelayMs: 50,
      socketFactory: () => {
        const s = new FakeWebSocket();
        sockets.push(s);
        return s;
      },
      nowMs: () => currentMs,
    });

    const interaction = new OrbitInteractionManager(provider, SOLAR_SYSTEM_BODIES);
    expect(interaction.getState().selectedUnitId).toBeNull();

    const sock = sockets[0]!;
    sock.emitOpen();
    expect(sock.sentMessages[0]).toEqual({
      type: 'join_room',
      roomId: 'room-alpha',
      preferredFaction: 'earth',
    });

    const joinedPromise = provider.waitUntilJoined();
    sock.emitServerMessage({
      type: 'room_joined',
      roomId: 'room-alpha',
      faction: 'earth',
      playerToken: 'tok-earth-1',
      protocolVersion: PROTOCOL_VERSION,
    });
    const info = await joinedPromise;
    expect(info.status).toBe('joined');
    expect(info.playerToken).toBe('tok-earth-1');

    const unitOrbit: KeplerOrbit = {
      a: 1.01,
      e: 0.017,
      omega: 0,
      meanAnomaly0: 0.1,
      epochSec: 0,
    };
    sock.emitServerMessage({
      type: 'snapshot',
      snapshot: makeSampleSnapshot(10.0, unitOrbit),
    });

    // Interaction manager automatically picks the mobile ship once initial snapshot arrives
    expect(interaction.getState().selectedUnitId).toBe('earth-raider-1');

    // Ping/pong RTT measurement
    const pingMsg = sock.sentMessages.find((m) => m.type === 'ping') as Extract<
      ClientMessage,
      { type: 'ping' }
    >;
    currentMs = 1014;
    sock.emitServerMessage({
      type: 'pong',
      sentAtMs: pingMsg.sentAtMs,
      serverTimeMs: Date.now(),
    });
    expect(provider.getStatusInfo().rttMs).toBe(14);

    // Command ack resolution
    const cmdPromise = provider.sendCommand({
      type: 'plan_intercept',
      unitId: 'earth-raider-1',
      targetRefId: 'eros',
      mode: 'fuel',
    });
    const cmdMsg = sock.sentMessages.find((m) => m.type === 'command') as Extract<
      ClientMessage,
      { type: 'command' }
    >;
    sock.emitServerMessage({
      type: 'command_ack',
      clientSeq: cmdMsg.clientSeq,
      accepted: true,
    });
    expect(await cmdPromise).toEqual({ accepted: true });

    // Intra-tick Keplerian smoothing (+50 ms ahead of 10.0s snapshot at t=1000ms -> 10.05s)
    const smoothed = provider.getSnapshot(1050);
    expect(smoothed.gameTimeSec).toBeCloseTo(10.05, 6);
    const expectedExact = orbitToState(unitOrbit, 10.05);
    const smoothedUnit = smoothed.ownUnits[0]!;
    const posErr = Math.hypot(
      smoothedUnit.pos.x - expectedExact.pos.x,
      smoothedUnit.pos.y - expectedExact.pos.y,
    );
    expect(posErr).toBeLessThan(1e-10);

    // Reconnect preserves playerToken
    sock.emitClose();
    expect(provider.getStatusInfo().status).toBe('reconnecting');
    await new Promise((r) => setTimeout(r, 70));
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    const reconnectedSock = sockets[1]!;
    reconnectedSock.emitOpen();
    expect(reconnectedSock.sentMessages[0]).toEqual({
      type: 'join_room',
      roomId: 'room-alpha',
      preferredFaction: 'earth',
      playerToken: 'tok-earth-1',
    });

    interaction.dispose();
    provider.dispose();
  });
});
