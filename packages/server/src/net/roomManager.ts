import { randomUUID } from 'node:crypto';
import {
  PROTOCOL_VERSION,
  SIM_TICK_RATE_HZ,
  type ClientMessage,
  type FactionId,
  type ServerMessage,
} from '@space-war/shared';
import { SimulationLoop, type TickSystemHook } from '../engine/simulationLoop.js';
import { createInitialWorldState } from '../engine/worldState.js';

export interface ClientConnection {
  id: string;
  send: (message: ServerMessage) => void;
}

interface RoomSlot {
  faction: FactionId;
  playerToken: string;
  conn: ClientConnection | null;
}

interface GameRoom {
  roomId: string;
  loop: SimulationLoop;
  slots: Record<FactionId, RoomSlot | null>;
}

interface ClientSession {
  roomId: string;
  faction: FactionId;
}

export interface RoomManagerOptions {
  autoStartLoop?: boolean;
  tickRateHz?: number;
  systems?: TickSystemHook[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isValidClientMessage(value: unknown): value is ClientMessage {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }
  switch (value.type) {
    case 'join_room':
      return typeof value.roomId === 'string' && value.roomId.trim().length > 0;
    case 'command':
      return isRecord(value.command) && typeof value.command.type === 'string';
    case 'ping':
      return typeof value.sentAtMs === 'number' && Number.isFinite(value.sentAtMs);
    default:
      return false;
  }
}

/**
 * Manages authoritative 2-player rooms (Earth vs Mars), reconnect tokens,
 * incoming PlayerCommand validation, and per-faction FactionSnapshot broadcasts.
 */
export class RoomManager {
  private readonly rooms = new Map<string, GameRoom>();
  private readonly sessions = new Map<string, ClientSession>();
  private readonly autoStartLoop: boolean;
  private readonly tickRateHz: number;
  private readonly systems: TickSystemHook[];

  constructor(options: RoomManagerOptions = {}) {
    this.autoStartLoop = options.autoStartLoop ?? false;
    this.tickRateHz = options.tickRateHz ?? SIM_TICK_RATE_HZ;
    this.systems = [...(options.systems ?? [])];
  }

  public getRoom(roomId: string): GameRoom | undefined {
    return this.rooms.get(roomId);
  }

  public getOrCreateRoom(roomId: string): GameRoom {
    const existing = this.rooms.get(roomId);
    if (existing) {
      return existing;
    }

    const loop = new SimulationLoop(createInitialWorldState(), {
      tickRateHz: this.tickRateHz,
      systems: this.systems,
      onTick: () => {
        this.broadcastRoomSnapshots(roomId);
      },
    });

    const room: GameRoom = {
      roomId,
      loop,
      slots: {
        earth: null,
        mars: null,
      },
    };
    this.rooms.set(roomId, room);
    return room;
  }

  public handleConnect(conn: ClientConnection): void {
    conn.send({
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      tickRateHz: this.tickRateHz,
    });
  }

  public handleDisconnect(conn: ClientConnection): void {
    const session = this.sessions.get(conn.id);
    if (!session) {
      return;
    }
    this.sessions.delete(conn.id);

    const room = this.rooms.get(session.roomId);
    if (!room) {
      return;
    }
    const slot = room.slots[session.faction];
    if (slot && slot.conn?.id === conn.id) {
      slot.conn = null;
    }
  }

  public handleMessage(conn: ClientConnection, raw: string | ClientMessage): void {
    let parsed: unknown = raw;
    if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw);
      } catch {
        conn.send({
          type: 'error',
          code: 'INVALID_JSON',
          message: 'Malformed JSON payload',
        });
        return;
      }
    }

    if (!isValidClientMessage(parsed)) {
      conn.send({
        type: 'error',
        code: 'INVALID_MESSAGE',
        message: 'Unrecognized or malformed client message',
      });
      return;
    }

    switch (parsed.type) {
      case 'ping':
        conn.send({
          type: 'pong',
          sentAtMs: parsed.sentAtMs,
          serverTimeMs: Date.now(),
        });
        return;

      case 'join_room':
        this.handleJoinRoom(conn, parsed);
        return;

      case 'command':
        this.handleCommand(conn, parsed);
        return;
    }
  }

  private handleJoinRoom(
    conn: ClientConnection,
    msg: Extract<ClientMessage, { type: 'join_room' }>,
  ): void {
    const roomId = msg.roomId.trim();
    const room = this.getOrCreateRoom(roomId);

    // Detach any prior session held by this connection
    this.handleDisconnect(conn);

    // Check reconnect token first
    if (msg.playerToken) {
      for (const faction of ['earth', 'mars'] as const) {
        const slot = room.slots[faction];
        if (slot && slot.playerToken === msg.playerToken) {
          if (slot.conn && slot.conn.id !== conn.id) {
            this.sessions.delete(slot.conn.id);
          }
          slot.conn = conn;
          this.sessions.set(conn.id, { roomId, faction });
          conn.send({
            type: 'room_joined',
            roomId,
            faction,
            playerToken: slot.playerToken,
            protocolVersion: PROTOCOL_VERSION,
          });
          conn.send({
            type: 'snapshot',
            snapshot: room.loop.getSnapshot(faction),
          });
          if (this.autoStartLoop && !room.loop.isRunning()) {
            room.loop.start();
          }
          return;
        }
      }
    }

    // Assign requested or available faction slot
    let chosenFaction: FactionId | null = null;
    if (msg.preferredFaction && room.slots[msg.preferredFaction] === null) {
      chosenFaction = msg.preferredFaction;
    } else if (room.slots.earth === null && (!msg.preferredFaction || msg.preferredFaction === 'earth')) {
      chosenFaction = 'earth';
    } else if (room.slots.mars === null && (!msg.preferredFaction || msg.preferredFaction === 'mars')) {
      chosenFaction = 'mars';
    } else if (room.slots.earth === null) {
      chosenFaction = 'earth';
    } else if (room.slots.mars === null) {
      chosenFaction = 'mars';
    }

    if (chosenFaction === null) {
      conn.send({
        type: 'error',
        code: 'ROOM_FULL',
        message: `Room ${roomId} already has both Earth and Mars players`,
      });
      return;
    }

    const playerToken = randomUUID();
    room.slots[chosenFaction] = {
      faction: chosenFaction,
      playerToken,
      conn,
    };
    this.sessions.set(conn.id, { roomId, faction: chosenFaction });

    conn.send({
      type: 'room_joined',
      roomId,
      faction: chosenFaction,
      playerToken,
      protocolVersion: PROTOCOL_VERSION,
    });
    conn.send({
      type: 'snapshot',
      snapshot: room.loop.getSnapshot(chosenFaction),
    });

    if (this.autoStartLoop && !room.loop.isRunning()) {
      room.loop.start();
    }
  }

  private handleCommand(
    conn: ClientConnection,
    msg: Extract<ClientMessage, { type: 'command' }>,
  ): void {
    const session = this.sessions.get(conn.id);
    if (!session) {
      conn.send({
        type: 'command_ack',
        ...(msg.clientSeq !== undefined ? { clientSeq: msg.clientSeq } : {}),
        accepted: false,
        reason: 'Client has not joined a room',
      });
      return;
    }

    const room = this.rooms.get(session.roomId);
    if (!room) {
      conn.send({
        type: 'command_ack',
        ...(msg.clientSeq !== undefined ? { clientSeq: msg.clientSeq } : {}),
        accepted: false,
        reason: 'Room no longer exists',
      });
      return;
    }

    const result = room.loop.submitCommand(session.faction, msg.command);
    conn.send({
      type: 'command_ack',
      ...(msg.clientSeq !== undefined ? { clientSeq: msg.clientSeq } : {}),
      accepted: result.accepted,
      ...(result.reason ? { reason: result.reason } : {}),
    });
  }

  public stepRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) {
      return;
    }
    room.loop.stepTick();
  }

  public broadcastRoomSnapshots(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) {
      return;
    }

    for (const faction of ['earth', 'mars'] as const) {
      const slot = room.slots[faction];
      if (!slot?.conn) {
        continue;
      }
      slot.conn.send({
        type: 'snapshot',
        snapshot: room.loop.getSnapshot(faction),
      });
    }
  }

  public stopAll(): void {
    for (const room of this.rooms.values()) {
      room.loop.stop();
    }
  }
}
