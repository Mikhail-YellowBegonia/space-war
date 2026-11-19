import type { FactionSnapshot } from '@space-war/shared';

export interface OscillatorNodeLike {
  type: OscillatorType;
  frequency: {
    setValueAtTime(value: number, startTime: number): void;
    exponentialRampToValueAtTime(value: number, endTime: number): void;
  };
  connect(destination: unknown): void;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface GainNodeLike {
  gain: {
    setValueAtTime(value: number, startTime: number): void;
    exponentialRampToValueAtTime(value: number, endTime: number): void;
  };
  connect(destination: unknown): void;
}

export interface AudioContextLike {
  readonly currentTime: number;
  readonly state: string;
  readonly destination: unknown;
  resume?(): Promise<void>;
  createOscillator(): OscillatorNodeLike;
  createGain(): GainNodeLike;
  close?(): Promise<void>;
}

export type CicCueKind = 'missile_alert' | 'radar_lock' | 'laser_pulse' | 'match_end';

export interface CicSoundEngineOptions {
  muted?: boolean;
  contextFactory?: () => AudioContextLike | null;
}

function defaultAudioContextFactory(): AudioContextLike | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const win = window as unknown as {
    AudioContext?: new () => AudioContextLike;
    webkitAudioContext?: new () => AudioContextLike;
  };
  const Ctor = win.AudioContext ?? win.webkitAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
}

/**
 * Lightweight Web Audio synthesizer for CIC alerts (incoming missile alarm,
 * radar confirmation beep, laser pulse, and match-end tone).
 */
export class CicSoundEngine {
  private readonly contextFactory: () => AudioContextLike | null;
  private ctx: AudioContextLike | null = null;
  private muted: boolean;

  private seenThreatIds = new Set<string>();
  private seenConfirmedIds = new Set<string>();
  private lastWinner: string | null = null;
  private readonly playedCues: CicCueKind[] = [];

  constructor(options: CicSoundEngineOptions = {}) {
    this.muted = options.muted ?? false;
    this.contextFactory = options.contextFactory ?? defaultAudioContextFactory;
  }

  isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  toggleMuted(): boolean {
    this.muted = !this.muted;
    return this.muted;
  }

  getPlayedCues(): readonly CicCueKind[] {
    return this.playedCues;
  }

  resetTracker(): void {
    this.seenThreatIds.clear();
    this.seenConfirmedIds.clear();
    this.lastWinner = null;
  }

  private ensureContext(): AudioContextLike | null {
    if (this.muted) {
      return null;
    }
    if (!this.ctx) {
      this.ctx = this.contextFactory();
    }
    if (this.ctx && this.ctx.state === 'suspended' && this.ctx.resume) {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  private playTone(
    type: OscillatorType,
    startFreqHz: number,
    endFreqHz: number,
    durationSec: number,
    gainPeak = 0.08,
    delaySec = 0,
  ): void {
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime + delaySec;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(40, startFreqHz), now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, endFreqHz), now + durationSec);

    gain.gain.setValueAtTime(gainPeak, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + durationSec);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + durationSec);
  }

  playIncomingMissileAlert(): void {
    this.playedCues.push('missile_alert');
    this.playTone('sawtooth', 880, 620, 0.12, 0.07, 0);
    this.playTone('sawtooth', 880, 620, 0.12, 0.07, 0.14);
  }

  playRadarLockBeep(): void {
    this.playedCues.push('radar_lock');
    this.playTone('sine', 1320, 1480, 0.07, 0.06, 0);
  }

  playLaserPulse(): void {
    this.playedCues.push('laser_pulse');
    this.playTone('square', 960, 220, 0.09, 0.05, 0);
  }

  playMatchEndCue(isVictory: boolean): void {
    this.playedCues.push('match_end');
    if (isVictory) {
      this.playTone('triangle', 523.25, 659.25, 0.16, 0.08, 0);
      this.playTone('triangle', 659.25, 783.99, 0.22, 0.08, 0.16);
    } else {
      this.playTone('sawtooth', 392, 261.63, 0.24, 0.07, 0);
    }
  }

  /**
   * Inspects incoming snapshots for edge-triggered audio cues (new incoming munition tracks,
   * newly confirmed radar locks, laser VFX events, and match conclusion).
   */
  processSnapshot(snapshot: FactionSnapshot): void {
    const nextThreatIds = new Set<string>();
    const nextConfirmedIds = new Set<string>();
    let hasNewThreat = false;
    let hasNewLock = false;

    for (const track of snapshot.tracks) {
      if (track.suspectedKind === 'munition') {
        nextThreatIds.add(track.trackId);
        if (!this.seenThreatIds.has(track.trackId)) {
          hasNewThreat = true;
        }
      }
      if (track.confidence === 'confirmed') {
        nextConfirmedIds.add(track.trackId);
        if (!this.seenConfirmedIds.has(track.trackId)) {
          hasNewLock = true;
        }
      }
    }

    this.seenThreatIds = nextThreatIds;
    this.seenConfirmedIds = nextConfirmedIds;

    if (hasNewThreat) {
      this.playIncomingMissileAlert();
    } else if (hasNewLock) {
      this.playRadarLockBeep();
    }

    if (snapshot.vfxEvents.some((ev) => ev.kind === 'laser')) {
      this.playLaserPulse();
    }

    if (snapshot.winner && snapshot.winner !== this.lastWinner) {
      this.lastWinner = snapshot.winner;
      this.playMatchEndCue(snapshot.winner === snapshot.faction);
    }
  }

  dispose(): void {
    if (this.ctx?.close) {
      void this.ctx.close();
    }
    this.ctx = null;
  }
}
