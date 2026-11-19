import {
  ALL_UNIT_KINDS,
  MUNITION_PROFILE_IDS,
  SOLAR_SYSTEM_BODIES,
  orbitToState,
  type KeplerOrbit,
  type MunitionEntity,
  type UnitEntity,
  type VfxEvent,
} from '@space-war/shared';
import { describe, expect, it } from 'vitest';
import { Camera2D } from '../src/camera/index.js';
import {
  MUNITION_PIXEL_SPRITES,
  PixelVfxSystem,
  SolarSystemVectorRenderer,
  UNIT_PIXEL_SPRITES,
  getPlumeColor,
  getRadiatorGlowColor,
  type Canvas2DContextLike,
} from '../src/render/index.js';

function createBenchmarkSpyCtx(): {
  ctx: Canvas2DContextLike;
  fillRectCount: () => number;
  nonFiniteCount: () => number;
} {
  let fillRects = 0;
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
      fillRects += 1;
    },
    strokeRect(x, y, w, h) {
      check(x, y, w, h);
    },
    fillText(_t, x, y) {
      check(x, y);
    },
    setLineDash() {},
  };
  return {
    ctx,
    fillRectCount: () => fillRects,
    nonFiniteCount: () => nonFinite,
  };
}

describe('SW-18 retro pixel sprites and direct pixel/particle VFX system', () => {
  it('defines consistent pixel sprites for all 11 unit kinds and 2 munition profiles', () => {
    for (const kind of ALL_UNIT_KINDS) {
      const sprite = UNIT_PIXEL_SPRITES[kind];
      expect(sprite.rows).toHaveLength(sprite.height);
      for (const row of sprite.rows) {
        expect(row).toHaveLength(sprite.width);
      }
    }

    for (const profileId of MUNITION_PROFILE_IDS) {
      const sprite = MUNITION_PIXEL_SPRITES[profileId];
      expect(sprite.rows).toHaveLength(sprite.height);
      for (const row of sprite.rows) {
        expect(row).toHaveLength(sprite.width);
      }
    }

    expect(getRadiatorGlowColor(0.9, false, false)).toBe('#2e414d');
    expect(getRadiatorGlowColor(0.1, true, false)).toBe('#4895ef');
    expect(getRadiatorGlowColor(0.5, true, false)).toBe('#ff9f1c');
    expect(getRadiatorGlowColor(0.85, true, false)).toBe('#ff4d4f');

    expect(getPlumeColor('nuclear', 0.8)).toBe('#fff2b2');
    expect(getPlumeColor('electric', 0.2)).toBe('#5ce1e6');
    expect(getPlumeColor('chemical', 0.4)).toBe('#ffae42');
  });

  it('ingests laser, CIWS, explosion, and plume VFX events and expires particles cleanly', () => {
    const vfx = new PixelVfxSystem();
    const events: VfxEvent[] = [
      { kind: 'laser', from: { x: 1.0, y: 0 }, to: { x: 1.02, y: 0.01 }, intensity: 0.9 },
      { kind: 'ciws', from: { x: 1.02, y: 0.01 }, intensity: 0.8 },
      { kind: 'explosion', from: { x: 1.05, y: -0.02 }, intensity: 1.0 },
      { kind: 'burn_flash', from: { x: 0.99, y: 0.01 }, intensity: 1.0 },
    ];

    vfx.ingestVfxEvents(events);
    vfx.emitThrusterPlume({ x: 1.0, y: 0 }, { x: -1, y: 0 }, 'nuclear', 0.8, 1.0);

    expect(vfx.getActiveBeamCount()).toBe(1);
    expect(vfx.getActiveParticleCount()).toBeGreaterThan(20);

    vfx.step(0.1);
    expect(vfx.getActiveBeamCount()).toBe(1);

    // Advance past max particle lifetime (~0.9s) so pool returns to idle
    for (let i = 0; i < 12; i++) {
      vfx.step(0.1);
    }
    expect(vfx.getActiveBeamCount()).toBe(0);
    expect(vfx.getActiveParticleCount()).toBe(0);
  });

  it('sustains >= 50fps (< 20ms/frame) rendering 24 ships and 60 flying munitions with pixel VFX', () => {
    const { ctx, fillRectCount, nonFiniteCount } = createBenchmarkSpyCtx();
    const renderer = new SolarSystemVectorRenderer(ctx);
    const camera = new Camera2D({
      center: { x: 1.0, y: 0 },
      viewSpanAu: 0.4,
      viewportWidth: 1280,
      viewportHeight: 800,
    });

    const units: UnitEntity[] = [];
    for (let i = 0; i < 24; i++) {
      const kind = ALL_UNIT_KINDS[i % ALL_UNIT_KINDS.length]!;
      const orbit: KeplerOrbit = {
        a: 0.95 + (i % 6) * 0.025,
        e: 0.02,
        omega: 0,
        meanAnomaly0: (i - 12) * 0.015,
        epochSec: 0,
      };
      const st = orbitToState(orbit, 0);
      units.push({
        id: `BENCH-${i}`,
        faction: i % 2 === 0 ? 'earth' : 'mars',
        kind,
        propulsion: i % 3 === 0 ? 'nuclear' : i % 3 === 1 ? 'chemical' : 'electric',
        pos: st.pos,
        vel: st.vel,
        orbit,
        hp: 200,
        maxHp: 200,
        subsystems: { propulsion: 'normal', sensors: 'normal', weapons: 'normal', thermal: 'normal' },
        deltaV: 0.02,
        maxDeltaV: 0.02,
        heat: (i % 10) * 10,
        maxHeat: 100,
        radiatorsOpen: true,
        emconSilent: false,
        radarActive: i % 2 === 0,
        jammerActive: false,
        ammoStock: 10,
        plannedBurns:
          i % 4 === 0
            ? [{ executeAtSec: 0, deltaV: { x: 0.001, y: 0.001 }, durationSec: 2, isOccludedStart: false }]
            : [],
      });
    }

    const munitions: MunitionEntity[] = [];
    for (let i = 0; i < 60; i++) {
      const orbit: KeplerOrbit = {
        a: 0.96 + (i % 10) * 0.015,
        e: 0.05,
        omega: 0.1,
        meanAnomaly0: (i - 30) * 0.008,
        epochSec: 0,
      };
      const st = orbitToState(orbit, 0);
      munitions.push({
        id: `MUN-${i}`,
        faction: 'earth',
        profileId: i % 2 === 0 ? 'light_interceptor' : 'heavy_torpedo',
        pos: st.pos,
        vel: st.vel,
        orbit,
        deltaV: 0.008,
        targetId: 'trk-target',
        seekerMode: 'ir',
        coldCoast: i % 5 === 0,
      });
    }

    const vfxEvents: VfxEvent[] = [
      { kind: 'laser', from: units[0]!.pos, to: munitions[0]!.pos, intensity: 1 },
      { kind: 'ciws', from: munitions[1]!.pos, intensity: 0.9 },
      { kind: 'explosion', from: munitions[2]!.pos, intensity: 1 },
    ];

    const frames = 30;
    const startMs = performance.now();
    for (let f = 0; f < frames; f++) {
      renderer.render({
        gameTimeSec: f * 0.016,
        viewportWidth: 1280,
        viewportHeight: 800,
        camera,
        bodies: SOLAR_SYSTEM_BODIES,
        units,
        ownMunitions: munitions,
        selectedUnitId: 'BENCH-0',
        vfxEvents: f === 0 ? vfxEvents : undefined,
      });
    }
    const elapsedMs = performance.now() - startMs;
    const msPerFrame = elapsedMs / frames;

    expect(nonFiniteCount()).toBe(0);
    expect(fillRectCount()).toBeGreaterThan(1000);
    // >= 50fps means <= 20ms per frame
    expect(msPerFrame).toBeLessThan(20);
  });
});
