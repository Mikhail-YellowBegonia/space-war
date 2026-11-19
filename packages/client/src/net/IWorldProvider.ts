import type { FactionId, FactionSnapshot, PlayerCommand } from '@space-war/shared';

export type SnapshotListener = (snapshot: FactionSnapshot) => void;

export interface CommandAck {
  accepted: boolean;
  reason?: string;
}

/**
 * Unified client world-data source abstraction implemented by both MockWorldProvider (SW-08)
 * and WsWorldProvider (SW-09).
 */
export interface IWorldProvider {
  readonly faction: FactionId;
  getSnapshot(): FactionSnapshot;
  subscribe(listener: SnapshotListener): () => void;
  sendCommand(command: PlayerCommand): Promise<CommandAck>;
  start?(): void;
  stop?(): void;
  dispose(): void;
}
