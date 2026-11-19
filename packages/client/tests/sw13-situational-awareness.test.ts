import { SOLAR_SYSTEM_BODIES, isOccluded } from '@space-war/shared';
import { describe, expect, it } from 'vitest';
import { Camera2D } from '../src/camera/index.js';
import { MockWorldProvider } from '../src/net/index.js';
import {
  SolarSystemVectorRenderer,
  computeConeSectorPoints,
  computeEllipseHatchSegments,
  computeJamNoiseArcs,
  computeOcclusionSectorPolygon,
  formatGhostLostTimer,
  sampleErrorEllipsePoints,
  type Canvas2DContextLike,
} from '../src/render/index.js';

function createSaSpyCtx(): {
  ctx: Canvas2DContextLike;
  texts: string[];
  nonFiniteCount: () => number;
  drawOrder: string[];
} {
  let nonFinite = 0;
  const texts: string[] = [];
  const drawOrder: string[] = [];
  const check = (...nums: number[]) => {
    for (const n of nums) {
      if (!Number.isFinite(n)) nonFinite += 1;
    }
  };

  let currentStroke = '';
  let currentFill = '';

  const ctx: Canvas2DContextLike = {
    get fillStyle() {
      return currentFill;
    },
    set fillStyle(val: string | CanvasGradient | CanvasPattern) {
      currentFill = String(val);
    },
    get strokeStyle() {
      return currentStroke;
    },
    set strokeStyle(val: string | CanvasGradient | CanvasPattern) {
      currentStroke = String(val);
    },
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
    fill() {
      if (currentFill.includes('46, 28, 72')) {
        drawOrder.push('occlusion_fill');
      }
    },
    stroke() {
      if (currentStroke.includes('110, 175, 200') || currentStroke.includes('125, 249, 255')) {
        drawOrder.push('orbit_stroke');
      }
    },
    fillRect(x, y, w, h) {
      check(x, y, w, h);
    },
    strokeRect(x, y, w, h) {
      check(x, y, w, h);
    },
    fillText(text, x, y) {
      check(x, y);
      texts.push(text);
    },
    setLineDash() {},
  };

  return { ctx, texts, nonFiniteCount: () => nonFinite, drawOrder };
}

describe('SW-13 situational awareness visualization layer', () => {
  it('computes accurate occlusion cones, rotated ellipse hatches, LADAR sectors, and jammer noise arcs', () => {
    const observer = { x: 1.0, y: 0 };
    const body = { x: 0.5, y: 0 };
    const poly = computeOcclusionSectorPolygon(observer, body, 0.04, 1.0);
    expect(poly).not.toBeNull();
    expect(poly).toHaveLength(4);

    // Midpoint behind body inside the occlusion polygon must test occluded by SW-03 isOccluded
    const centroid = {
      x: poly!.reduce((s, p) => s + p.x, 0) / 4,
      y: poly!.reduce((s, p) => s + p.y, 0) / 4,
    };
    expect(isOccluded(observer, centroid, [{ pos: body, occlusionRadiusAu: 0.04 }])).toBe(true);

    // Rotated ellipse & hatch bounds
    const center = { x: 1.5, y: -0.4 };
    const major = 0.2;
    const minor = 0.08;
    const angle = 0.6;
    const perimeter = sampleErrorEllipsePoints(center, major, minor, angle, 24);
    expect(perimeter).toHaveLength(25);

    const hatches = computeEllipseHatchSegments(center, major, minor, angle, 7);
    expect(hatches).toHaveLength(7);
    const cosA = Math.cos(-angle);
    const sinA = Math.sin(-angle);
    for (const seg of hatches) {
      for (const pt of [seg.from, seg.to]) {
        const dx = pt.x - center.x;
        const dy = pt.y - center.y;
        const lx = dx * cosA - dy * sinA;
        const ly = dx * sinA + dy * cosA;
        const normSq = (lx / major) ** 2 + (ly / minor) ** 2;
        expect(normSq).toBeLessThanOrEqual(1 + 1e-9);
      }
    }

    const cone = computeConeSectorPoints({ x: 1, y: 0 }, 0, 0.3, 0.05, 8);
    expect(cone).toHaveLength(10);
    expect(computeJamNoiseArcs(1.25, 6)).toHaveLength(6);
    expect(formatGhostLostTimer(14)).toBe('LOST 14s');
    expect(formatGhostLostTimer(75)).toBe('LOST 01:15');
  });

  it('provides all 4 track confidence tiers and transitions occluded tracks to ghost in MockWorldProvider', () => {
    const provider = new MockWorldProvider({ faction: 'earth', autoStart: false });
    const snap0 = provider.getSnapshot();

    const confidences = new Set(snap0.tracks.map((t) => t.confidence));
    expect(confidences.has('bearing')).toBe(true);
    expect(confidences.has('uncertain')).toBe(true);
    expect(confidences.has('confirmed')).toBe(true);
    expect(confidences.has('ghost')).toBe(true);
    expect(snap0.tracks.some((t) => t.isJammed)).toBe(true);

    // Confirm raider starts visible (uncertain), then move it opposite the Sun so Sun occludes it
    const raiderBefore = snap0.tracks.find((t) => t.trackId === 'trk-mars-raider')!;
    expect(raiderBefore.confidence).toBe('uncertain');

    provider.step(5);
    const visibleSnap = provider.getSnapshot();
    expect(visibleSnap.tracks.find((t) => t.trackId === 'trk-mars-raider')!.lastObservedSec).toBeCloseTo(
      5,
      6,
    );

    // Move raider directly behind the Sun relative to Earth (x ≈ -1.0, y ≈ 0)
    provider.setScriptedRaiderOrbit({
      a: 1.0,
      e: 0,
      omega: 0,
      meanAnomaly0: Math.PI,
      epochSec: 0,
    });
    provider.step(12);

    const occludedSnap = provider.getSnapshot();
    const ghostRaider = occludedSnap.tracks.find((t) => t.trackId === 'trk-mars-raider')!;
    expect(ghostRaider.confidence).toBe('ghost');
    expect(ghostRaider.lastObservedSec).toBeCloseTo(5, 6);
    expect(occludedSnap.gameTimeSec - ghostRaider.lastObservedSec).toBeCloseTo(12, 6);

    provider.dispose();
  });

  it('renders occlusion wedges below orbit lines, 4-tier tracks, LADAR cone, and jammed noise rings', async () => {
    const provider = new MockWorldProvider({ faction: 'earth', autoStart: false });
    // Activate jammer on E-CRS-1 so active jammer ring also renders
    await provider.sendCommand({
      type: 'set_emcon',
      unitId: 'E-CRS-1',
      silent: false,
      radiatorsOpen: true,
      radarActive: true,
      jammerActive: true,
    });
    provider.step(2);

    const snap = provider.getSnapshot();
    const { ctx, texts, nonFiniteCount, drawOrder } = createSaSpyCtx();
    const renderer = new SolarSystemVectorRenderer(ctx);
    const camera = new Camera2D({ viewSpanAu: 4.5, viewportWidth: 1280, viewportHeight: 800 });

    renderer.render({
      gameTimeSec: snap.gameTimeSec,
      viewportWidth: 1280,
      viewportHeight: 800,
      camera,
      bodies: SOLAR_SYSTEM_BODIES,
      units: snap.ownUnits,
      tracks: snap.tracks,
      selectedUnitId: 'E-RCN-1',
    });

    expect(nonFiniteCount()).toBe(0);

    // Verify occlusion fills are drawn strictly before orbit strokes so orbits stay unobstructed
    const firstOrbitIdx = drawOrder.indexOf('orbit_stroke');
    const lastOcclusionIdx = drawOrder.lastIndexOf('occlusion_fill');
    expect(firstOrbitIdx).toBeGreaterThan(-1);
    expect(lastOcclusionIdx).toBeGreaterThan(-1);
    expect(lastOcclusionIdx).toBeLessThan(firstOrbitIdx);

    // Verify all 4 track tiers and jammed indicator labels were drawn
    expect(texts.some((t) => t.startsWith('[BRG]'))).toBe(true);
    expect(texts.some((t) => t.startsWith('[UNC]'))).toBe(true);
    expect(texts.some((t) => t.startsWith('[JAMMED]'))).toBe(true);
    expect(texts.some((t) => t.startsWith('[LOCK]'))).toBe(true);
    expect(texts.some((t) => t.startsWith('[GHOST]') && t.includes('LOST'))).toBe(true);

    provider.dispose();
  });
});
