import { SOLAR_SYSTEM_BODIES, getBodyStateAt } from '@space-war/shared';
import { describe, expect, it } from 'vitest';
import { Camera2D } from '../src/camera/index.js';
import {
  OrbitInteractionManager,
  buildOrbitFromTwoPointDrag,
  getOrbitApsisPositions,
  updateOrbitFromApsisHandleDrag,
} from '../src/interaction/index.js';
import { MockWorldProvider } from '../src/net/index.js';
import { SolarSystemVectorRenderer, type Canvas2DContextLike } from '../src/render/index.js';
import {
  formatBingoSummary,
  formatDeltaVKmPerSec,
  formatDurationMmSs,
  formatIrRisk,
} from '../src/ui/index.js';

function createMinimalSpyCtx(): { ctx: Canvas2DContextLike; nonFiniteCount: () => number } {
  let nonFinite = 0;
  const check = (...nums: number[]) => {
    for (const n of nums) {
      if (!Number.isFinite(n)) nonFinite += 1;
    }
  };
  const ctx: Canvas2DContextLike = {
    fillStyle: '#000',
    strokeStyle: '#fff',
    lineWidth: 1,
    font: '10px monospace',
    textAlign: 'left',
    textBaseline: 'top',
    globalAlpha: 1,
    save() {},
    restore() {},
    beginPath() {},
    closePath() {},
    moveTo(x, y) {
      check(x, y);
    },
    lineTo(x, y) {
      check(x, y);
    },
    arc(x, y, r, s, e) {
      check(x, y, r, s, e);
    },
    rect(x, y, w, h) {
      check(x, y, w, h);
    },
    fill() {},
    stroke() {},
    fillRect(x, y, w, h) {
      check(x, y, w, h);
    },
    strokeRect(x, y, w, h) {
      check(x, y, w, h);
    },
    fillText(_t, x, y) {
      check(x, y);
    },
    setLineDash() {},
  };
  return { ctx, nonFiniteCount: () => nonFinite };
}

describe('SW-08 MockWorldProvider, orbit drag interaction, and Bingo confirmation', () => {
  it('runs standalone MockWorldProvider and executes planned burns over stepped ticks', async () => {
    const provider = new MockWorldProvider({ faction: 'earth', autoStart: false });
    const initialSnap = provider.getSnapshot();

    expect(initialSnap.faction).toBe('earth');
    expect(initialSnap.ownUnits.length).toBeGreaterThanOrEqual(5);
    expect(initialSnap.tracks.length).toBeGreaterThanOrEqual(3);

    const reconBefore = initialSnap.ownUnits.find((u) => u.id === 'E-RCN-1')!;
    const ack = await provider.sendCommand({
      type: 'plan_intercept',
      unitId: 'E-RCN-1',
      targetRefId: 'mars',
      mode: 'fuel',
    });
    expect(ack.accepted).toBe(true);

    const afterCmd = provider.getSnapshot().ownUnits.find((u) => u.id === 'E-RCN-1')!;
    expect(afterCmd.plannedBurns.length).toBeGreaterThan(0);

    // Advance simulation past the first scheduled burn window so delta-v is consumed
    const firstBurnAt = afterCmd.plannedBurns[0]!.executeAtSec;
    const totalSteps = Math.min(4000, Math.ceil((firstBurnAt + 10) / 0.1));
    for (let i = 0; i < totalSteps; i++) {
      provider.step(0.1);
    }
    const afterStep = provider.getSnapshot().ownUnits.find((u) => u.id === 'E-RCN-1')!;
    expect(afterStep.deltaV).toBeLessThan(reconBefore.deltaV);
    provider.dispose();
  });

  it('supports ellipse handle dragging in orbit_insertion mode and generates 3 transfer options', async () => {
    const provider = new MockWorldProvider({ faction: 'earth', autoStart: false });
    const interaction = new OrbitInteractionManager(provider, SOLAR_SYSTEM_BODIES);
    const camera = new Camera2D({ viewSpanAu: 5.0, viewportWidth: 1280, viewportHeight: 800 });

    interaction.selectUnit('E-RCN-1');
    interaction.setMode('orbit_insertion');

    const startState = interaction.getState();
    expect(startState.mode).toBe('orbit_insertion');
    expect(startState.draftOrbit).not.toBeNull();
    expect(startState.options).toHaveLength(3);
    expect(startState.options!.map((o) => o.mode)).toEqual(['fuel', 'fast', 'stealth']);

    // Drag the apoapsis handle outward to ~1.6 AU
    const handles = startState.apsisHandles!;
    const dragTargetScreen = camera.worldToScreen({
      x: handles.apoapsis.x * 1.5,
      y: handles.apoapsis.y * 1.5,
    });
    const apoHandleScreen = camera.worldToScreen(handles.apoapsis);

    expect(interaction.beginPointerAction(apoHandleScreen, camera)).toBe(true);
    expect(interaction.updatePointerDrag(dragTargetScreen, camera)).toBe(true);
    interaction.endPointerAction();

    const updated = interaction.getState();
    expect(updated.apsisHandles!.ra).toBeGreaterThan(1.3);
    expect(updated.options).toHaveLength(3);

    // Pure two-point drag helper test
    const twoPt = buildOrbitFromTwoPointDrag({ x: 1.0, y: 0 }, { x: -1.8, y: 0 });
    const twoPtApsides = getOrbitApsisPositions(twoPt);
    expect(twoPtApsides.rp).toBeCloseTo(1.0, 6);
    expect(twoPtApsides.ra).toBeCloseTo(1.8, 6);

    // Handle swap when periapsis is dragged outward past apoapsis
    const swapped = updateOrbitFromApsisHandleDrag(twoPt, 'periapsis', { x: 2.4, y: 0 });
    const swappedApsides = getOrbitApsisPositions(swapped);
    expect(swappedApsides.rp).toBeCloseTo(1.8, 6);
    expect(swappedApsides.ra).toBeCloseTo(2.4, 6);

    // Execute orbit insertion command
    const execResult = await interaction.requestExecute();
    expect(execResult.status).toBe('executed');

    interaction.dispose();
    provider.dispose();
  });

  it('clicks Mars on the map in intercept mode, switches 3 cards, and triggers Bingo red-line confirmation', async () => {
    const provider = new MockWorldProvider({ faction: 'earth', autoStart: false });
    const interaction = new OrbitInteractionManager(provider, SOLAR_SYSTEM_BODIES);
    const camera = new Camera2D({ viewSpanAu: 6.0, viewportWidth: 1280, viewportHeight: 800 });

    // Select E-RDR-1 (raider with tight 0.0068 AU/s delta-v) and switch to intercept mode
    interaction.selectUnit('E-RDR-1');
    interaction.setMode('intercept');

    const marsBody = SOLAR_SYSTEM_BODIES.find((b) => b.id === 'mars')!;
    const marsWorld = getBodyStateAt(marsBody, 0).pos;
    const marsScreen = camera.worldToScreen(marsWorld);

    expect(interaction.beginPointerAction(marsScreen, camera)).toBe(true);

    const stateAfterPick = interaction.getState();
    expect(stateAfterPick.interceptTarget?.refId).toBe('mars');
    expect(stateAfterPick.options).toHaveLength(3);

    // Switch preview cards between fuel, fast, stealth
    interaction.selectTransferMode('fast');
    expect(interaction.getSelectedOption()?.mode).toBe('fast');
    interaction.selectTransferMode('fuel');
    expect(interaction.getSelectedOption()?.mode).toBe('fuel');

    // E-RDR-1 flying to Mars has enough delta-v to arrive, but not enough to return -> Bingo RED
    const fuelToMars = stateAfterPick.options![0];
    expect(fuelToMars.feasible).toBe(true);
    expect(fuelToMars.bingoWarning).toBe('red');

    const firstTry = await interaction.requestExecute();
    expect(firstTry.status).toBe('needs_bingo_confirm');
    expect(interaction.getState().pendingBingoConfirm).toBe(true);

    // Cancel works
    interaction.cancelBingoConfirm();
    expect(interaction.getState().pendingBingoConfirm).toBe(false);

    // Re-trigger and confirm
    const secondTry = await interaction.requestExecute();
    expect(secondTry.status).toBe('needs_bingo_confirm');
    const confirmed = await interaction.confirmBingoExecute();
    expect(confirmed.status).toBe('executed');
    const unitAfter = provider.getSnapshot().ownUnits.find((u) => u.id === 'E-RDR-1')!;
    expect(unitAfter.plannedBurns.length).toBeGreaterThan(0);

    interaction.dispose();
    provider.dispose();
  });

  it('renders transfer preview segments and apsis handles with finite coordinates', () => {
    const provider = new MockWorldProvider({ faction: 'earth', autoStart: false });
    const interaction = new OrbitInteractionManager(provider, SOLAR_SYSTEM_BODIES);
    const camera = new Camera2D({ viewSpanAu: 5.5, viewportWidth: 1280, viewportHeight: 800 });

    interaction.selectUnit('E-CRS-1');
    interaction.setMode('orbit_insertion');
    interaction.updateDraftOrbit({ a: 1.35, e: 0.22, omega: 0.4, meanAnomaly0: 0, epochSec: 0 });

    const snap = provider.getSnapshot();
    const uiState = interaction.getState();
    const { ctx, nonFiniteCount } = createMinimalSpyCtx();
    const renderer = new SolarSystemVectorRenderer(ctx);

    renderer.render({
      gameTimeSec: snap.gameTimeSec,
      viewportWidth: 1280,
      viewportHeight: 800,
      camera,
      bodies: SOLAR_SYSTEM_BODIES,
      units: snap.ownUnits,
      tracks: snap.tracks,
      selectedUnitId: uiState.selectedUnitId,
      previewTransfer: {
        option: interaction.getSelectedOption()!,
        draftOrbit: uiState.draftOrbit,
        apsisHandles: uiState.apsisHandles
          ? {
              periapsis: uiState.apsisHandles.periapsis,
              apoapsis: uiState.apsisHandles.apoapsis,
            }
          : null,
      },
    });

    expect(nonFiniteCount()).toBe(0);
    interaction.dispose();
    provider.dispose();
  });

  it('formats delta-v, duration, IR risk, and Bingo summaries for HUD display', () => {
    expect(formatDeltaVKmPerSec(0.005)).toMatch(/km\/s$/);
    expect(formatDurationMmSs(178)).toBe('02:58');
    expect(formatIrRisk(0.95)).toEqual({ label: '极高', percent: '95%' });
    expect(formatIrRisk(0.08)).toEqual({ label: '低', percent: '8%' });

    const summary = formatBingoSummary(
      {
        mode: 'fuel',
        feasible: true,
        burns: [],
        previewOrbitSegments: [],
        arrivalSec: 180,
        totalDeltaV: 0.005,
        estimatedPeakIr: 0.2,
        bingoDeltaV: 0.004,
        bingoWarning: 'red',
      },
      0.006,
    );
    expect(summary.level).toBe('red');
    expect(summary.text).toContain('RED');
  });
});
