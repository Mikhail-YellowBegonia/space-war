import type { FactionId, FactionSnapshot } from '@space-war/shared';

export type MatchScreenPhase = 'lobby' | 'playing' | 'victory';
export type LobbyPlayMode = 'mock' | 'ws';

export interface LobbyConfig {
  playMode: LobbyPlayMode;
  roomId: string;
  faction: FactionId;
}

export interface MatchSummary {
  winner: FactionId;
  playerFaction: FactionId;
  isVictory: boolean;
  durationSec: number;
  ownWonderComplete: number;
  ownWonderTotal: number;
  enemyWonderProgress: number;
  survivingUnits: number;
  remainingOre: number;
  remainingPropellant: number;
  freighterCap: number;
}

export interface MatchFlowState {
  phase: MatchScreenPhase;
  lobby: LobbyConfig;
  crtEnabled: boolean;
  soundMuted: boolean;
  summary: MatchSummary | null;
}

export type MatchFlowListener = (state: MatchFlowState) => void;

export function buildMatchSummary(snapshot: FactionSnapshot): MatchSummary | null {
  if (!snapshot.winner) {
    return null;
  }
  const ownWonderComplete = snapshot.ownWonder.filter((s) => s.status === 'complete').length;
  return {
    winner: snapshot.winner,
    playerFaction: snapshot.faction,
    isVictory: snapshot.winner === snapshot.faction,
    durationSec: snapshot.gameTimeSec,
    ownWonderComplete,
    ownWonderTotal: snapshot.ownWonder.length,
    enemyWonderProgress: snapshot.enemyWonderPublicProgress,
    survivingUnits: snapshot.ownUnits.filter((u) => u.hp > 0).length,
    remainingOre: Math.round(snapshot.resources.ore),
    remainingPropellant: Math.round(snapshot.resources.propellant),
    freighterCap: snapshot.freighterCap,
  };
}

/**
 * Coordinates the Lobby -> Active CIC Match -> Victory Summary screen flow,
 * CRT post-processing toggle, and Web Audio mute state.
 */
export class MatchFlowController {
  private phase: MatchScreenPhase;
  private lobby: LobbyConfig;
  private crtEnabled: boolean;
  private soundMuted: boolean;
  private summary: MatchSummary | null = null;
  private readonly listeners = new Set<MatchFlowListener>();

  constructor(options: {
    initialPhase?: MatchScreenPhase;
    lobby?: Partial<LobbyConfig>;
    crtEnabled?: boolean;
    soundMuted?: boolean;
  } = {}) {
    this.phase = options.initialPhase ?? 'lobby';
    this.lobby = {
      playMode: options.lobby?.playMode ?? 'mock',
      roomId: options.lobby?.roomId ?? 'alpha-1',
      faction: options.lobby?.faction ?? 'earth',
    };
    this.crtEnabled = options.crtEnabled ?? true;
    this.soundMuted = options.soundMuted ?? false;
  }

  subscribe(listener: MatchFlowListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.listeners.clear();
  }

  getState(): MatchFlowState {
    return {
      phase: this.phase,
      lobby: { ...this.lobby },
      crtEnabled: this.crtEnabled,
      soundMuted: this.soundMuted,
      summary: this.summary ? { ...this.summary } : null,
    };
  }

  setLobbyConfig(patch: Partial<LobbyConfig>): void {
    this.lobby = {
      ...this.lobby,
      ...patch,
      roomId: patch.roomId !== undefined ? patch.roomId.trim() || 'alpha-1' : this.lobby.roomId,
    };
    this.emit();
  }

  startMatch(override?: Partial<LobbyConfig>): LobbyConfig {
    if (override) {
      this.lobby = {
        ...this.lobby,
        ...override,
        roomId: override.roomId !== undefined ? override.roomId.trim() || 'alpha-1' : this.lobby.roomId,
      };
    }
    this.summary = null;
    this.phase = 'playing';
    this.emit();
    return { ...this.lobby };
  }

  returnToLobby(): void {
    this.summary = null;
    this.phase = 'lobby';
    this.emit();
  }

  toggleCrt(): boolean {
    this.crtEnabled = !this.crtEnabled;
    this.emit();
    return this.crtEnabled;
  }

  setCrtEnabled(enabled: boolean): void {
    this.crtEnabled = enabled;
    this.emit();
  }

  setSoundMuted(muted: boolean): void {
    this.soundMuted = muted;
    this.emit();
  }

  /**
   * Transitions automatically to the victory summary panel once a snapshot reports `winner`.
   */
  observeSnapshot(snapshot: FactionSnapshot): void {
    if (this.phase === 'playing' && snapshot.winner) {
      this.summary = buildMatchSummary(snapshot);
      this.phase = 'victory';
      this.emit();
    }
  }

  private emit(): void {
    const state = this.getState();
    for (const fn of this.listeners) {
      fn(state);
    }
  }
}
