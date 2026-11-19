import {
  LOGISTICS_CONFIG,
  SOLAR_SYSTEM_BODIES,
  WONDER_CONFIG,
  getBodyStateAt,
  orbitToState,
  type CelestialBody,
  type ClientMessage,
  type FactionId,
  type FactionSnapshot,
  type PlayerCommand,
  type ServerMessage,
  type WonderSlot,
} from '@space-war/shared';
import type { CommandAck, IWorldProvider, SnapshotListener } from './IWorldProvider.js';

export type WsConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'joined'
  | 'reconnecting'
  | 'error';

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: unknown) => void,
  ): void;
  removeEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: unknown) => void,
  ): void;
}

export interface WsWorldProviderOptions {
  url: string;
  roomId: string;
  preferredFaction?: FactionId;
  playerToken?: string;
  autoConnect?: boolean;
  reconnectDelayMs?: number;
  commandTimeoutMs?: number;
  maxExtrapolationSec?: number;
  celestialBodies?: readonly CelestialBody[];
  socketFactory?: (url: string) => WebSocketLike;
  nowMs?: () => number;
}

export interface WsStatusInfo {
  status: WsConnectionStatus;
  roomId: string;
  faction: FactionId;
  playerToken: string | null;
  rttMs: number | null;
  lastError: string | null;
}

export type WsStatusListener = (info: WsStatusInfo) => void;

const WS_OPEN_READY_STATE = 1;

function createEmptyWonderSlots(): WonderSlot[] {
  const slots: WonderSlot[] = [];
  for (let index = 0; index < WONDER_CONFIG.slotCount; index++) {
    slots.push({
      index,
      status: 'empty',
      progressOre: 0,
      requiredOre: WONDER_CONFIG.orePerSlot,
      hp: WONDER_CONFIG.slotMaxHp,
      maxHp: WONDER_CONFIG.slotMaxHp,
    });
  }
  return slots;
}

function createBaselineSnapshot(
  faction: FactionId,
  bodies: readonly CelestialBody[],
): FactionSnapshot {
  return {
    tick: 0,
    gameTimeSec: 0,
    faction,
    resources: { ore: 0, propellant: 0 },
    freighterCap: LOGISTICS_CONFIG.initialFreighterCap,
    freightersInFlight: 0,
    celestials: bodies.map((b) => {
      const state = getBodyStateAt(b, 0);
      return { id: b.id, pos: state.pos, vel: state.vel };
    }),
    ownUnits: [],
    ownMunitions: [],
    tracks: [],
    routes: [],
    ownWonder: createEmptyWonderSlots(),
    enemyWonderPublicProgress: 0,
    vfxEvents: [],
    winner: null,
  };
}

function extractMessageText(event: unknown): string | null {
  if (typeof event === 'object' && event !== null && 'data' in event) {
    const data = (event as { data: unknown }).data;
    if (typeof data === 'string') {
      return data;
    }
  }
  return null;
}

/**
 * WebSocket-backed world provider connecting to `@space-war/server` rooms.
 * Supports automatic token-based reconnection, command ack tracking, RTT ping,
 * and smooth 60fps intra-tick Keplerian extrapolation between 10Hz server snapshots.
 */
export class WsWorldProvider implements IWorldProvider {
  private readonly url: string;
  private readonly roomId: string;
  private readonly preferredFaction?: FactionId;
  private readonly reconnectDelayMs: number;
  private readonly commandTimeoutMs: number;
  private readonly maxExtrapolationSec: number;
  private readonly bodies: readonly CelestialBody[];
  private readonly socketFactory: (url: string) => WebSocketLike;
  private readonly nowMs: () => number;

  private readonly snapshotListeners = new Set<SnapshotListener>();
  private readonly statusListeners = new Set<WsStatusListener>();
  private readonly pendingCommands = new Map<
    number,
    { resolve: (ack: CommandAck) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly joinWaiters: Array<{
    resolve: (info: WsStatusInfo) => void;
    reject: (err: Error) => void;
  }> = [];

  private _faction: FactionId;
  private playerToken: string | null;
  private status: WsConnectionStatus = 'disconnected';
  private lastError: string | null = null;
  private rttMs: number | null = null;

  private socket: WebSocketLike | null = null;
  private disposed = false;
  private nextClientSeq = 1;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  private authoritativeSnapshot: FactionSnapshot;
  private lastSnapshotReceivedAtMs = 0;

  constructor(options: WsWorldProviderOptions) {
    this.url = options.url;
    this.roomId = options.roomId;
    this.preferredFaction = options.preferredFaction;
    this._faction = options.preferredFaction ?? 'earth';
    this.playerToken = options.playerToken ?? null;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1500;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 5000;
    this.maxExtrapolationSec = options.maxExtrapolationSec ?? 0.25;
    this.bodies = options.celestialBodies ?? SOLAR_SYSTEM_BODIES;
    this.nowMs = options.nowMs ?? (() => performance.now());
    this.socketFactory =
      options.socketFactory ??
      ((targetUrl: string) => new WebSocket(targetUrl) as unknown as WebSocketLike);

    this.authoritativeSnapshot = createBaselineSnapshot(this._faction, this.bodies);

    if (options.autoConnect !== false) {
      this.start();
    }
  }

  get faction(): FactionId {
    return this._faction;
  }

  getStatusInfo(): WsStatusInfo {
    return {
      status: this.status,
      roomId: this.roomId,
      faction: this._faction,
      playerToken: this.playerToken,
      rttMs: this.rttMs,
      lastError: this.lastError,
    };
  }

  onStatusChange(listener: WsStatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.getStatusInfo());
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  start(): void {
    if (this.disposed || this.socket !== null) {
      return;
    }
    this.clearReconnectTimer();
    this.setStatus(this.playerToken ? 'reconnecting' : 'connecting');
    this.connectSocket();
  }

  stop(): void {
    this.clearReconnectTimer();
    this.clearPingTimer();
    this.teardownSocket();
    if (this.status !== 'disconnected') {
      this.setStatus('disconnected');
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.stop();
    this.rejectAllPendingCommands('WsWorldProvider disposed');
    this.rejectJoinWaiters(new Error('WsWorldProvider disposed'));
    this.snapshotListeners.clear();
    this.statusListeners.clear();
  }

  /**
   * Resolves once the client finishes `room_joined` handshake with the server.
   */
  waitUntilJoined(timeoutMs = 5000): Promise<WsStatusInfo> {
    if (this.status === 'joined') {
      return Promise.resolve(this.getStatusInfo());
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.joinWaiters.findIndex((w) => w.resolve === wrappedResolve);
        if (idx >= 0) {
          this.joinWaiters.splice(idx, 1);
        }
        reject(new Error(`Timed out waiting to join room ${this.roomId}`));
      }, timeoutMs);

      const wrappedResolve = (info: WsStatusInfo) => {
        clearTimeout(timer);
        resolve(info);
      };
      const wrappedReject = (err: Error) => {
        clearTimeout(timer);
        reject(err);
      };
      this.joinWaiters.push({ resolve: wrappedResolve, reject: wrappedReject });
    });
  }

  subscribe(listener: SnapshotListener): () => void {
    this.snapshotListeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.snapshotListeners.delete(listener);
    };
  }

  /**
   * Returns the latest authoritative snapshot smoothly extrapolated along each entity's
   * Keplerian orbit between 10Hz server ticks to prevent 60fps rendering stutter.
   */
  getSnapshot(overrideNowMs?: number): FactionSnapshot {
    const base = this.authoritativeSnapshot;
    if (this.lastSnapshotReceivedAtMs <= 0 || this.maxExtrapolationSec <= 0) {
      return base;
    }

    const now = overrideNowMs ?? this.nowMs();
    const dtSec = Math.max(0, Math.min(this.maxExtrapolationSec, (now - this.lastSnapshotReceivedAtMs) / 1000));
    if (dtSec <= 1e-4) {
      return base;
    }

    const smoothedTimeSec = base.gameTimeSec + dtSec;
    const bodyById = new Map(this.bodies.map((b) => [b.id, b]));

    return {
      ...base,
      gameTimeSec: smoothedTimeSec,
      celestials: base.celestials.map((cel) => {
        const body = bodyById.get(cel.id);
        if (!body) return cel;
        const state = getBodyStateAt(body, smoothedTimeSec);
        return { id: cel.id, pos: state.pos, vel: state.vel };
      }),
      ownUnits: base.ownUnits.map((unit) => {
        const state = orbitToState(unit.orbit, smoothedTimeSec);
        return {
          ...unit,
          pos: state.pos,
          vel: state.vel,
        };
      }),
      ownMunitions: base.ownMunitions.map((mun) => {
        const state = orbitToState(mun.orbit, smoothedTimeSec);
        return {
          ...mun,
          pos: state.pos,
          vel: state.vel,
        };
      }),
    };
  }

  getAuthoritativeSnapshot(): FactionSnapshot {
    return this.authoritativeSnapshot;
  }

  sendCommand(command: PlayerCommand): Promise<CommandAck> {
    if (!this.socket || this.socket.readyState !== WS_OPEN_READY_STATE) {
      return Promise.resolve({ accepted: false, reason: 'WebSocket not connected' });
    }
    if (this.status !== 'joined') {
      return Promise.resolve({ accepted: false, reason: 'Not joined to a room yet' });
    }

    const clientSeq = this.nextClientSeq++;
    const payload: ClientMessage = {
      type: 'command',
      clientSeq,
      command,
    };

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(clientSeq);
        resolve({ accepted: false, reason: 'Command acknowledgement timed out' });
      }, this.commandTimeoutMs);

      this.pendingCommands.set(clientSeq, { resolve, timer });
      this.sendClientMessage(payload);
    });
  }

  sendPing(): void {
    if (!this.socket || this.socket.readyState !== WS_OPEN_READY_STATE) {
      return;
    }
    this.sendClientMessage({
      type: 'ping',
      sentAtMs: Math.round(this.nowMs()),
    });
  }

  private connectSocket(): void {
    let sock: WebSocketLike;
    try {
      sock = this.socketFactory(this.url);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : 'Failed to open WebSocket';
      this.setStatus('error');
      this.scheduleReconnect();
      return;
    }

    this.socket = sock;
    sock.addEventListener('open', this.handleSocketOpen);
    sock.addEventListener('message', this.handleSocketMessage);
    sock.addEventListener('close', this.handleSocketClose);
    sock.addEventListener('error', this.handleSocketError);
  }

  private teardownSocket(): void {
    if (!this.socket) {
      return;
    }
    const sock = this.socket;
    this.socket = null;
    sock.removeEventListener('open', this.handleSocketOpen);
    sock.removeEventListener('message', this.handleSocketMessage);
    sock.removeEventListener('close', this.handleSocketClose);
    sock.removeEventListener('error', this.handleSocketError);
    try {
      sock.close();
    } catch {
      // Ignore already-closed sockets
    }
  }

  private readonly handleSocketOpen = (): void => {
    this.lastError = null;
    this.sendClientMessage({
      type: 'join_room',
      roomId: this.roomId,
      ...(this.preferredFaction ? { preferredFaction: this.preferredFaction } : {}),
      ...(this.playerToken ? { playerToken: this.playerToken } : {}),
    });

    this.clearPingTimer();
    this.pingTimer = setInterval(() => {
      this.sendPing();
    }, 3000);
  };

  private readonly handleSocketMessage = (event: unknown): void => {
    const raw = extractMessageText(event);
    if (!raw) {
      return;
    }

    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }

    switch (msg.type) {
      case 'hello':
        return;

      case 'room_joined': {
        this._faction = msg.faction;
        this.playerToken = msg.playerToken;
        this.lastError = null;
        this.setStatus('joined');
        this.sendPing();

        const info = this.getStatusInfo();
        while (this.joinWaiters.length > 0) {
          this.joinWaiters.shift()!.resolve(info);
        }
        return;
      }

      case 'snapshot': {
        this.authoritativeSnapshot = msg.snapshot;
        this.lastSnapshotReceivedAtMs = this.nowMs();
        this.emitSnapshot();
        return;
      }

      case 'command_ack': {
        if (msg.clientSeq !== undefined) {
          const pending = this.pendingCommands.get(msg.clientSeq);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingCommands.delete(msg.clientSeq);
            pending.resolve({
              accepted: msg.accepted,
              ...(msg.reason ? { reason: msg.reason } : {}),
            });
          }
        }
        return;
      }

      case 'pong': {
        this.rttMs = Math.max(0, Math.round(this.nowMs() - msg.sentAtMs));
        this.emitStatus();
        return;
      }

      case 'error': {
        this.lastError = `${msg.code}: ${msg.message}`;
        this.setStatus('error');
        if (msg.code === 'ROOM_FULL') {
          this.rejectJoinWaiters(new Error(this.lastError));
        }
        return;
      }
    }
  };

  private readonly handleSocketClose = (): void => {
    this.clearPingTimer();
    this.teardownSocket();
    this.rejectAllPendingCommands('WebSocket connection closed');

    if (this.disposed) {
      return;
    }

    if (this.status !== 'error') {
      this.setStatus('reconnecting');
    }
    this.scheduleReconnect();
  };

  private readonly handleSocketError = (): void => {
    this.lastError = 'WebSocket transport error';
    this.setStatus('error');
  };

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null || this.reconnectDelayMs <= 0) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.disposed && this.socket === null) {
        this.connectSocket();
      }
    }, this.reconnectDelayMs);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearPingTimer(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private sendClientMessage(message: ClientMessage): void {
    if (!this.socket || this.socket.readyState !== WS_OPEN_READY_STATE) {
      return;
    }
    this.socket.send(JSON.stringify(message));
  }

  private rejectAllPendingCommands(reason: string): void {
    for (const [seq, pending] of this.pendingCommands.entries()) {
      clearTimeout(pending.timer);
      pending.resolve({ accepted: false, reason });
      this.pendingCommands.delete(seq);
    }
  }

  private rejectJoinWaiters(err: Error): void {
    while (this.joinWaiters.length > 0) {
      this.joinWaiters.shift()!.reject(err);
    }
  }

  private setStatus(next: WsConnectionStatus): void {
    this.status = next;
    this.emitStatus();
  }

  private emitStatus(): void {
    const info = this.getStatusInfo();
    for (const listener of this.statusListeners) {
      listener(info);
    }
  }

  private emitSnapshot(): void {
    const snap = this.getSnapshot();
    for (const listener of this.snapshotListeners) {
      listener(snap);
    }
  }
}
