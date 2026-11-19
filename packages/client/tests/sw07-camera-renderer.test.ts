import { SOLAR_SYSTEM_BODIES, isInUmbra } from '@space-war/shared';
import { describe, expect, it } from 'vitest';
import { createPreviewUnits } from '../src/app.js';
import {
  CAMERA_LIMITS,
  Camera2D,
  getSemanticZoomTier,
} from '../src/camera/index.js';
import {
  SolarSystemVectorRenderer,
  clipSegmentToRect,
  computeScaleBarSpec,
  computeUmbraSectorPolygon,
  sampleOrbitPoints,
  type Canvas2DContextLike,
} from '../src/render/index.js';

interface RecordedDrawStats {
  arcCalls: number;
  lineToCalls: number;
  fillRectCalls: number;
  texts: string[];
  nonFiniteArgs: number;
}

function createSpyContext(): { ctx: Canvas2DContextLike; stats: RecordedDrawStats } {
  const stats: RecordedDrawStats = {
    arcCalls: 0,
    lineToCalls: 0,
    fillRectCalls: 0,
    texts: [],
    nonFiniteArgs: 0,
  };

  const checkNums = (...nums: number[]) => {
    for (const n of nums) {
      if (!Number.isFinite(n)) {
        stats.nonFiniteArgs += 1;
      }
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
      checkNums(x, y);
    },
    lineTo(x, y) {
      checkNums(x, y);
      stats.lineToCalls += 1;
    },
    arc(x, y, r, start, end) {
      checkNums(x, y, r, start, end);
      stats.arcCalls += 1;
    },
    rect(x, y, w, h) {
      checkNums(x, y, w, h);
    },
    fill() {},
    stroke() {},
    fillRect(x, y, w, h) {
      checkNums(x, y, w, h);
      stats.fillRectCalls += 1;
    },
    strokeRect(x, y, w, h) {
      checkNums(x, y, w, h);
    },
    fillText(text, x, y) {
      checkNums(x, y);
      stats.texts.push(text);
    },
    setLineDash() {},
  };

  return { ctx, stats };
}

describe('SW-07 double-precision camera and solar system vector renderer', () => {
  it('maintains float64 round-trip accuracy and zoom range [0.05, 7.0] AU', () => {
    const cam = new Camera2D({
      center: { x: 3.14, y: -1.25 },
      viewSpanAu: 0.05,
      viewportWidth: 1280,
      viewportHeight: 800,
    });

    const target = { x: 3.1415926535, y: -1.2481234567 };
    const screen = cam.worldToScreen(target);
    const back = cam.screenToWorld(screen);

    expect(back.x).toBeCloseTo(target.x, 12);
    expect(back.y).toBeCloseTo(target.y, 12);

    cam.setViewSpanAu(0.001);
    expect(cam.getViewSpanAu()).toBe(CAMERA_LIMITS.minViewSpanAu);

    cam.setViewSpanAu(20);
    expect(cam.getViewSpanAu()).toBe(CAMERA_LIMITS.maxViewSpanAu);
  });

  it('preserves world anchor under cursor on zoom and pans accurately by screen delta', () => {
    const cam = new Camera2D({
      center: { x: 0.5, y: -0.3 },
      viewSpanAu: 4.0,
      viewportWidth: 1000,
      viewportHeight: 800,
    });

    const anchor = { x: 720, y: 240 };
    const worldBefore = cam.screenToWorld(anchor);
    cam.zoomAtScreenPos(0.5, anchor);
    const worldAfter = cam.screenToWorld(anchor);

    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 12);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 12);

    const beforeCenter = cam.getCenter();
    const pxPerAu = cam.getPixelsPerAu();
    cam.panByScreenDelta(160, -80);
    const afterCenter = cam.getCenter();

    expect(afterCenter.x).toBeCloseTo(beforeCenter.x - 160 / pxPerAu, 12);
    expect(afterCenter.y).toBeCloseTo(beforeCenter.y + 80 / pxPerAu, 12);
  });

  it('switches semantic zoom tiers cleanly across strategic, operational, and tactical spans', () => {
    expect(getSemanticZoomTier(7.0)).toBe('strategic');
    expect(getSemanticZoomTier(2.5)).toBe('strategic');
    expect(getSemanticZoomTier(1.2)).toBe('operational');
    expect(getSemanticZoomTier(0.45)).toBe('tactical');
    expect(getSemanticZoomTier(0.05)).toBe('tactical');
  });

  it('samples closed Kepler ellipses, clips screen segments, and aligns umbra polygons with SW-03', () => {
    const pts = sampleOrbitPoints({ a: 2.0, e: 0.25, omega: 0, meanAnomaly0: 0, epochSec: 0 }, 64);
    expect(pts).toHaveLength(65);
    expect(pts[0].x).toBeCloseTo(pts[64].x, 10);
    expect(pts[0].y).toBeCloseTo(pts[64].y, 10);
    // Periapsis at nu=0 -> r = a*(1-e) = 1.5; apoapsis at nu=pi -> r = a*(1+e) = 2.5
    expect(pts[0].x).toBeCloseTo(1.5, 10);
    expect(pts[32].x).toBeCloseTo(-2.5, 10);

    const clipped = clipSegmentToRect(
      { x: -10000, y: 400 },
      { x: 10000, y: 400 },
      0,
      0,
      1280,
      800,
    );
    expect(clipped).not.toBeNull();
    expect(clipped![0].x).toBeCloseTo(0, 10);
    expect(clipped![0].y).toBeCloseTo(400, 10);
    expect(clipped![1].x).toBeCloseTo(1280, 10);
    expect(clipped![1].y).toBeCloseTo(400, 10);
    expect(clipSegmentToRect({ x: -50, y: -10 }, { x: -10, y: -10 }, 0, 0, 1280, 800)).toBeNull();

    const earthUmbra = computeUmbraSectorPolygon({ x: 1.0, y: 0 }, 0.036, 0.3);
    expect(earthUmbra).not.toBeNull();
    // Centroid of umbra polygon should test true under SW-03 isInUmbra
    const centroid = {
      x: earthUmbra!.reduce((s, p) => s + p.x, 0) / earthUmbra!.length,
      y: earthUmbra!.reduce((s, p) => s + p.y, 0) / earthUmbra!.length,
    };
    expect(isInUmbra(centroid, [{ pos: { x: 1.0, y: 0 }, occlusionRadiusAu: 0.036, umbraLengthAu: 0.3 }])).toBe(true);

    expect(computeScaleBarSpec(120).au).toBe(1);
    expect(computeScaleBarSpec(16000).au).toBe(0.005);
  });

  it('renders Sun, all 10 celestial bodies, umbra wedges, and semantic-zoom units with finite coords', () => {
    const units = createPreviewUnits(0);

    // Strategic full-system render (7.0 AU)
    const strategicSpy = createSpyContext();
    const strategicRenderer = new SolarSystemVectorRenderer(strategicSpy.ctx);
    const strategicCam = new Camera2D({ viewSpanAu: 7.0, viewportWidth: 1280, viewportHeight: 800 });

    strategicRenderer.render({
      gameTimeSec: 0,
      viewportWidth: 1280,
      viewportHeight: 800,
      camera: strategicCam,
      bodies: SOLAR_SYSTEM_BODIES,
      units,
      selectedUnitId: 'E-RCN-1',
    });

    expect(strategicSpy.stats.nonFiniteArgs).toBe(0);
    expect(strategicSpy.stats.texts).toContain('Sun');
    expect(strategicSpy.stats.texts).toContain('Earth');
    expect(strategicSpy.stats.texts).toContain('433 Eros');
    expect(strategicSpy.stats.texts).toContain('10 Hygiea');
    expect(strategicSpy.stats.texts).toContain('E-RCN-1');
    expect(strategicSpy.stats.texts).not.toContain('M-RDR-1');

    // Tight tactical render (0.05 AU centered near Earth)
    const tacticalSpy = createSpyContext();
    const tacticalRenderer = new SolarSystemVectorRenderer(tacticalSpy.ctx);
    const tacticalCam = new Camera2D({
      center: { x: 0.983, y: 0 },
      viewSpanAu: 0.05,
      viewportWidth: 1280,
      viewportHeight: 800,
    });

    tacticalRenderer.render({
      gameTimeSec: 0,
      viewportWidth: 1280,
      viewportHeight: 800,
      camera: tacticalCam,
      bodies: SOLAR_SYSTEM_BODIES,
      units,
      selectedUnitId: 'E-HOME',
    });

    expect(tacticalSpy.stats.nonFiniteArgs).toBe(0);
    expect(tacticalSpy.stats.texts.some((t) => t.startsWith('Earth (1.00 AU)'))).toBe(true);
    expect(tacticalSpy.stats.texts).toContain('E-HOME [C]');
    // Background fillRect + 2 micro bars (background+fill = 4 rects) for E-HOME
    expect(tacticalSpy.stats.fillRectCalls).toBeGreaterThanOrEqual(5);
  });
});
