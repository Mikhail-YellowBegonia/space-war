import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CicSoundEngine,
  type AudioContextLike,
  type GainNodeLike,
  type OscillatorNodeLike,
} from '../src/audio/index.js';
import { MockWorldProvider } from '../src/net/index.js';
import { MatchFlowController, buildMatchSummary } from '../src/ui/index.js';

function createFakeAudioContext(): {
  ctx: AudioContextLike;
  oscillatorsStarted: () => number;
} {
  let startedCount = 0;
  const ctx: AudioContextLike = {
    currentTime: 0,
    state: 'running',
    destination: {},
    createOscillator(): OscillatorNodeLike {
      return {
        type: 'sine',
        frequency: {
          setValueAtTime() {},
          exponentialRampToValueAtTime() {},
        },
        connect() {},
        start() {
          startedCount += 1;
        },
        stop() {},
      };
    },
    createGain(): GainNodeLike {
      return {
        gain: {
          setValueAtTime() {},
          exponentialRampToValueAtTime() {},
        },
        connect() {},
      };
    },
  };
  return { ctx, oscillatorsStarted: () => startedCount };
}

describe('SW-23 CRT toggle, Web Audio CIC cues, and Lobby -> Victory flow', () => {
  it('completes Lobby -> Playing -> Victory -> Play Again / Return to Lobby flow', () => {
    const provider = new MockWorldProvider({ faction: 'earth', autoStart: false });
    const flow = new MatchFlowController({ initialPhase: 'lobby' });

    const unsub = provider.subscribe((snap) => {
      flow.observeSnapshot(snap);
    });

    expect(flow.getState().phase).toBe('lobby');
    flow.setLobbyConfig({ playMode: 'ws', faction: 'mars', roomId: 'room-42' });
    expect(flow.getState().lobby).toEqual({
      playMode: 'ws',
      faction: 'mars',
      roomId: 'room-42',
    });

    flow.startMatch({ playMode: 'mock', faction: 'earth' });
    expect(flow.getState().phase).toBe('playing');

    provider.step(12);
    provider.concludeMatch('earth');

    const victoryState = flow.getState();
    expect(victoryState.phase).toBe('victory');
    expect(victoryState.summary).not.toBeNull();
    expect(victoryState.summary!.isVictory).toBe(true);
    expect(victoryState.summary!.winner).toBe('earth');
    expect(victoryState.summary!.durationSec).toBeCloseTo(12, 6);
    expect(victoryState.summary!.ownWonderTotal).toBe(16);

    // Also test direct summary null when winner is absent
    const freshProvider = new MockWorldProvider({ faction: 'mars', autoStart: false });
    expect(buildMatchSummary(freshProvider.getSnapshot())).toBeNull();

    // Play again & return to lobby
    flow.startMatch();
    expect(flow.getState().phase).toBe('playing');
    expect(flow.getState().summary).toBeNull();

    flow.returnToLobby();
    expect(flow.getState().phase).toBe('lobby');

    unsub();
    flow.dispose();
    provider.dispose();
    freshProvider.dispose();
  });

  it('toggles CRT state cleanly and keeps #crt-overlay layered beneath #hud-root in index.html', () => {
    const flow = new MatchFlowController();
    expect(flow.getState().crtEnabled).toBe(true);
    expect(flow.toggleCrt()).toBe(false);
    expect(flow.getState().crtEnabled).toBe(false);
    expect(flow.toggleCrt()).toBe(true);

    const htmlPath = fileURLToPath(new URL('../index.html', import.meta.url));
    const html = readFileSync(htmlPath, 'utf8');
    expect(html).toContain('id="crt-overlay"');
    expect(html).toContain('#crt-overlay');
    expect(html).toMatch(/#crt-overlay\s*\{[\s\S]*?z-index:\s*15;/);
    expect(html).toMatch(/#hud-root\s*\{[\s\S]*?z-index:\s*20;/);
    flow.dispose();
  });

  it('synthesizes missile alert, radar lock, laser pulse, and match-end Web Audio cues and honors mute', () => {
    const fake = createFakeAudioContext();
    const audio = new CicSoundEngine({ muted: false, contextFactory: () => fake.ctx });
    const provider = new MockWorldProvider({ faction: 'earth', autoStart: false });

    const snap0 = provider.getSnapshot();
    audio.processSnapshot(snap0);
    expect(audio.getPlayedCues()).toContain('missile_alert');
    expect(fake.oscillatorsStarted()).toBeGreaterThanOrEqual(2);

    // Trigger laser VFX + match end
    const snapLaser = {
      ...snap0,
      vfxEvents: [
        { kind: 'laser' as const, from: { x: 1, y: 0 }, to: { x: 1.02, y: 0 }, intensity: 0.8 },
      ],
      winner: 'earth' as const,
    };
    audio.processSnapshot(snapLaser);
    expect(audio.getPlayedCues()).toContain('laser_pulse');
    expect(audio.getPlayedCues()).toContain('match_end');

    // Radar lock beep on newly confirmed non-munition track
    const countBeforeLock = fake.oscillatorsStarted();
    audio.processSnapshot({
      ...snap0,
      tracks: [
        ...snap0.tracks,
        {
          trackId: 'trk-new-lock',
          confidence: 'confirmed',
          suspectedKind: 'ship',
          pos: { x: 1.3, y: 0.2 },
          lastObservedSec: 1,
          isJammed: false,
        },
      ],
    });
    expect(audio.getPlayedCues()).toContain('radar_lock');
    expect(fake.oscillatorsStarted()).toBeGreaterThan(countBeforeLock);

    // Mute suppresses new oscillator starts
    const countBeforeMute = fake.oscillatorsStarted();
    audio.setMuted(true);
    audio.playIncomingMissileAlert();
    audio.playLaserPulse();
    expect(fake.oscillatorsStarted()).toBe(countBeforeMute);

    audio.dispose();
    provider.dispose();
  });
});
