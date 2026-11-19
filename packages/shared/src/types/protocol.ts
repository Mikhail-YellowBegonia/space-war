import type { FactionId, FactionSnapshot, PlayerCommand } from './domain.js';

/**
 * Messages sent from client to authoritative WebSocket game server.
 */
export type ClientMessage =
  | {
      type: 'join_room';
      roomId: string;
      preferredFaction?: FactionId;
      playerToken?: string;
    }
  | {
      type: 'command';
      command: PlayerCommand;
      clientSeq?: number;
    }
  | {
      type: 'ping';
      sentAtMs: number;
    };

/**
 * Messages sent from authoritative WebSocket game server to client.
 */
export type ServerMessage =
  | {
      type: 'hello';
      protocolVersion: string;
      tickRateHz?: number;
    }
  | {
      type: 'room_joined';
      roomId: string;
      faction: FactionId;
      playerToken: string;
      protocolVersion: string;
    }
  | {
      type: 'snapshot';
      snapshot: FactionSnapshot;
    }
  | {
      type: 'command_ack';
      clientSeq?: number;
      accepted: boolean;
      reason?: string;
    }
  | {
      type: 'error';
      code: string;
      message: string;
    }
  | {
      type: 'pong';
      sentAtMs: number;
      serverTimeMs: number;
    };
