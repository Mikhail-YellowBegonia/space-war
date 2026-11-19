import { SOLAR_SYSTEM_BODIES } from '@space-war/shared';
import { describe, expect, it } from 'vitest';
import { Camera2D } from '../src/camera/index.js';
import {
  FireControlManager,
  computeEngagementAdvisories,
  isTrackTargetableForFire,
  selectTracksInScreenBox,
} from '../src/interaction/index.js';
import { MockWorldProvider } from '../src/net/index.js';
import { SolarSystemVectorRenderer, type Canvas2DContextLike } from '../src/render/index.js';

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

describe('SW-17 BVR fire control, cold-coast salvos, and anti-missile box selection', () => {
  it('completes track -> cold-coast torpedo salvo -> box-select incoming missiles -> intercept flow', async () => {
    const provider = new MockWorldProvider({ faction: 'earth', autoStart: false });
    const fireControl = new FireControlManager(provider);
    const camera = new Camera2D({
      center: { x: 1.0, y: 0 },
      viewSpanAu: 1.2,
      viewportWidth: 1280,
      viewportHeight: 800,
    });

    const snap0 = provider.getSnapshot();
    const cruiser = snap0.ownUnits.find((u) => u.id === 'E-CRS-1')!;
    const escort = snap0.ownUnits.find((u) => u.id === 'E-ESC-1')!;
    expect(cruiser.ammoStock).toBeGreaterThanOrEqual(4);
    expect(escort.ammoStock).toBeGreaterThanOrEqual(4);

    // 1. Cannot fire at pure bearing or ghost tracks
    const bearingTrack = snap0.tracks.find((t) => t.confidence === 'bearing')!;
    const ghostTrack = snap0.tracks.find((t) => t.confidence === 'ghost')!;
    expect(isTrackTargetableForFire(bearingTrack)).toBe(false);
    expect(isTrackTargetableForFire(ghostTrack)).toBe(false);

    const rejectBearing = await fireControl.fireAtSelectedTargets(cruiser, [bearingTrack.trackId]);
    expect(rejectBearing.accepted).toBe(false);

    // 2. Fire cold-coast heavy torpedo salvo at confirmed enemy home track
    fireControl.setProfileId('heavy_torpedo');
    fireControl.setSalvoCount(2);
    fireControl.setColdCoast(true);
    fireControl.selectTargetTrack('trk-mars-home');

    const torpedoAck = await fireControl.fireAtSelectedTargets(cruiser);
    expect(torpedoAck.accepted).toBe(true);

    const afterTorpSnap = provider.getSnapshot();
    const cruiserAfter = afterTorpSnap.ownUnits.find((u) => u.id === 'E-CRS-1')!;
    expect(cruiserAfter.ammoStock).toBe(cruiser.ammoStock - 2);
    expect(afterTorpSnap.ownMunitions).toHaveLength(2);
    expect(afterTorpSnap.ownMunitions.every((m) => m.coldCoast && m.profileId === 'heavy_torpedo')).toBe(
      true,
    );

    // 3. Light interceptor forces coldCoast=false
    fireControl.setProfileId('light_interceptor');
    expect(fireControl.getState().coldCoast).toBe(false);

    // 4. Box-select incoming enemy munition tracks on screen
    const incomingTracks = afterTorpSnap.tracks.filter((t) => t.suspectedKind === 'munition');
    expect(incomingTracks.length).toBe(2);

    const screenPts = incomingTracks.map((t) => camera.worldToScreen(t.pos!));
    const box = {
      x1: Math.min(...screenPts.map((p) => p.x)) - 25,
      y1: Math.min(...screenPts.map((p) => p.y)) - 25,
      x2: Math.max(...screenPts.map((p) => p.x)) + 25,
      y2: Math.max(...screenPts.map((p) => p.y)) + 25,
    };

    const rawBoxHits = selectTracksInScreenBox(box, camera, afterTorpSnap, true);
    expect(rawBoxHits).toHaveLength(2);

    fireControl.beginTargetBoxOrPick({ x: box.x1, y: box.y1 });
    fireControl.updateTargetBoxDrag({ x: box.x2, y: box.y2 });
    const picked = fireControl.endTargetBoxOrPick({ x: box.x2, y: box.y2 }, camera);
    expect(picked).toHaveLength(2);
    expect(fireControl.getState().selectedTargetTrackIds).toEqual(
      expect.arrayContaining(['trk-mars-torp-1', 'trk-mars-torp-2']),
    );

    // 5. Assign interceptors from E-ESC-1 and step until interception succeeds
    const latestEscort = provider.getSnapshot().ownUnits.find((u) => u.id === 'E-ESC-1')!;
    const interceptAck = await fireControl.assignInterceptorsToIncoming(latestEscort);
    expect(interceptAck.accepted).toBe(true);

    let sawInterceptVfx = false;
    for (let i = 0; i < 400; i++) {
      provider.step(0.1);
      const s = provider.getSnapshot();
      if (s.vfxEvents.some((e) => e.kind === 'ciws')) {
        sawInterceptVfx = true;
      }
      if (s.tracks.filter((t) => t.suspectedKind === 'munition').length === 0) {
        break;
      }
    }

    const finalIncoming = provider.getSnapshot().tracks.filter((t) => t.suspectedKind === 'munition');
    expect(finalIncoming).toHaveLength(0);
    expect(sawInterceptVfx).toBe(true);

    fireControl.dispose();
    provider.dispose();
  });

  it('computes incoming munition and close-range brawl advisories and renders fire-control overlays cleanly', () => {
    const provider = new MockWorldProvider({ faction: 'earth', autoStart: false });
    const snap = provider.getSnapshot();
    const advisories = computeEngagementAdvisories(snap);

    expect(advisories.some((a) => a.kind === 'incoming_munition')).toBe(true);

    // Also verify close_range_brawl advisory triggers when an enemy track is within 0.04 AU
    const earthHome = snap.ownUnits.find((u) => u.id === 'E-HOME')!;
    const brawlSnap = {
      ...snap,
      tracks: [
        ...snap.tracks,
        {
          trackId: 'trk-close-raider',
          confidence: 'confirmed' as const,
          suspectedKind: 'ship' as const,
          pos: { x: earthHome.pos.x + 0.02, y: earthHome.pos.y },
          vel: { x: 0, y: 0.02 },
          lastObservedSec: snap.gameTimeSec,
          isJammed: false,
        },
      ],
    };
    const brawlAdvisories = computeEngagementAdvisories(brawlSnap);
    expect(brawlAdvisories.some((a) => a.kind === 'close_range_brawl')).toBe(true);

    const { ctx, nonFiniteCount } = createMinimalSpyCtx();
    const renderer = new SolarSystemVectorRenderer(ctx);
    const camera = new Camera2D({ viewSpanAu: 2.0, viewportWidth: 1280, viewportHeight: 800 });

    renderer.render({
      gameTimeSec: brawlSnap.gameTimeSec,
      viewportWidth: 1280,
      viewportHeight: 800,
      camera,
      bodies: SOLAR_SYSTEM_BODIES,
      units: brawlSnap.ownUnits,
      ownMunitions: [
        {
          id: 'mun-test-1',
          faction: 'earth',
          profileId: 'heavy_torpedo',
          pos: { x: earthHome.pos.x + 0.05, y: earthHome.pos.y + 0.02 },
          vel: { x: 0.01, y: 0.02 },
          orbit: earthHome.orbit,
          deltaV: 0.01,
          targetId: 'trk-mars-home',
          seekerMode: 'inertial_then_active',
          coldCoast: true,
        },
      ],
      tracks: brawlSnap.tracks,
      selectedUnitId: 'E-ESC-1',
      selectedTargetTrackIds: ['trk-mars-torp-1'],
      boxSelectRect: { x1: 600, y1: 350, x2: 720, y2: 440 },
      engagementAdvisories: brawlAdvisories,
    });

    expect(nonFiniteCount()).toBe(0);
    provider.dispose();
  });
});
