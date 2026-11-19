import {
  CELESTIAL_BODIES_BY_ID,
  SOLAR_SYSTEM_BODIES,
  getBodyStateAt,
  type WonderSlot,
} from '@space-war/shared';
import { describe, expect, it } from 'vitest';
import { Camera2D } from '../src/camera/index.js';
import { LogisticsBuildController, getBuildCatalog } from '../src/interaction/index.js';
import { MockWorldProvider } from '../src/net/index.js';
import {
  SolarSystemVectorRenderer,
  computeCoOrbitalWonderNodes,
  type Canvas2DContextLike,
} from '../src/render/index.js';

function createMinimalSpyCtx(): {
  ctx: Canvas2DContextLike;
  texts: string[];
  nonFiniteCount: () => number;
} {
  let nonFinite = 0;
  const texts: string[] = [];
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
    fillText(text, x, y) {
      check(x, y);
      texts.push(text);
    },
    setLineDash() {},
  };
  return { ctx, texts, nonFiniteCount: () => nonFinite };
}

describe('SW-21 logistics route management, home-base build queue, and 16-slot co-orbital wonder HUD', () => {
  it('completes route detour waypoint + escort binding within 3 interaction steps', async () => {
    const provider = new MockWorldProvider({ faction: 'earth', autoStart: false });
    const controller = new LogisticsBuildController(provider);

    // Step 1: start detour placement; Step 2: click deep-space waypoint; Step 3: bind escort
    controller.beginDetourPlacement('earth-route-1');
    expect(controller.getState().pendingDetourRouteId).toBe('earth-route-1');

    const detourAck = await controller.setDetourWaypoint('earth-route-1', { x: 0.85, y: 0.45 });
    expect(detourAck.accepted).toBe(true);
    expect(controller.getState().pendingDetourRouteId).toBeNull();

    const escortAck = await controller.toggleEscortBinding('earth-route-1', 'E-ESC-1');
    expect(escortAck.accepted).toBe(true);

    // Also verify pause, batch size cycling, and stealth mode
    await controller.toggleRoutePaused('earth-route-1');
    await controller.cycleBatchSize('earth-route-1');
    await controller.setTransferMode('earth-route-1', 'stealth');

    const updatedRoute = provider.getSnapshot().routes.find((r) => r.id === 'earth-route-1')!;
    expect(updatedRoute.detourWaypoint).toEqual({ x: 0.85, y: 0.45 });
    expect(updatedRoute.escortUnitIds).toEqual(['E-ESC-1']);
    expect(updatedRoute.paused).toBe(true);
    expect(updatedRoute.batchSize).toBe(2);
    expect(updatedRoute.transferMode).toBe('stealth');

    controller.dispose();
    provider.dispose();
  });

  it('queues freighter capacity, ships, outposts, relay depots, and wonder slots at home base', async () => {
    const provider = new MockWorldProvider({ faction: 'earth', autoStart: false });
    const controller = new LogisticsBuildController(provider);

    expect(getBuildCatalog().length).toBeGreaterThanOrEqual(8);

    const before = provider.getSnapshot();
    expect((await controller.queueBuild('freighter_cap')).accepted).toBe(true);
    expect((await controller.queueBuild('wonder_slot')).accepted).toBe(true);
    expect((await controller.queueBuild('outpost', 'eros')).accepted).toBe(true);
    expect((await controller.placeRelayDepotAt({ x: 1.25, y: 0.35 })).accepted).toBe(true);
    expect((await controller.queueBuild('escort_frigate')).accepted).toBe(true);

    const after = provider.getSnapshot();
    expect(after.freighterCap).toBe(before.freighterCap + 1);
    expect(after.resources.ore).toBeLessThan(before.resources.ore);
    expect(after.ownWonder.filter((s) => s.status === 'building').length).toBe(2);
    expect(after.ownUnits.some((u) => u.kind === 'mining_outpost')).toBe(true);
    expect(after.ownUnits.some((u) => u.kind === 'relay_depot')).toBe(true);

    controller.dispose();
    provider.dispose();
  });

  it('keeps all 16 wonder slots co-orbital with home base and renders all slot statuses & route waypoints', () => {
    const provider = new MockWorldProvider({ faction: 'earth', autoStart: false });
    const snap = provider.getSnapshot();
    const wonderWithDamaged: WonderSlot[] = snap.ownWonder.map((s) =>
      s.index === 2 ? { ...s, status: 'damaged_halted' } : s,
    );

    const earthBody = CELESTIAL_BODIES_BY_ID.earth!;
    const nodesT0 = computeCoOrbitalWonderNodes('earth', wonderWithDamaged, 0);
    const nodesT63 = computeCoOrbitalWonderNodes('earth', wonderWithDamaged, 63);
    const nodesT252 = computeCoOrbitalWonderNodes('earth', wonderWithDamaged, 252);
    expect(nodesT0).toHaveLength(16);

    const earthAt0 = getBodyStateAt(earthBody, 0).pos;
    const earthAt63 = getBodyStateAt(earthBody, 63).pos;
    const earthAngle0 = Math.atan2(earthAt0.y, earthAt0.x);
    const earthAngle63 = Math.atan2(earthAt63.y, earthAt63.x);

    // Every slot shares Earth's semi-major axis & eccentricity and completes a synchronous 252s orbit
    for (let i = 0; i < 16; i++) {
      expect(nodesT0[i]!.orbit.a).toBe(earthBody.orbit!.a);
      expect(nodesT0[i]!.orbit.e).toBe(earthBody.orbit!.e);
      expect(nodesT252[i]!.pos.x).toBeCloseTo(nodesT0[i]!.pos.x, 10);
      expect(nodesT252[i]!.pos.y).toBeCloseTo(nodesT0[i]!.pos.y, 10);

      const ang0 = Math.atan2(nodesT0[i]!.pos.y, nodesT0[i]!.pos.x) - earthAngle0;
      const ang63 = Math.atan2(nodesT63[i]!.pos.y, nodesT63[i]!.pos.x) - earthAngle63;
      const delta = Math.atan2(Math.sin(ang63 - ang0), Math.cos(ang63 - ang0));
      expect(Math.abs(delta)).toBeLessThan(0.1);
    }

    const { ctx, texts, nonFiniteCount } = createMinimalSpyCtx();
    const renderer = new SolarSystemVectorRenderer(ctx);
    const camera = new Camera2D({ viewSpanAu: 4.5, viewportWidth: 1280, viewportHeight: 800 });

    const routesWithDetour = snap.routes.map((r, idx) =>
      idx === 0 ? { ...r, detourWaypoint: { x: 0.85, y: 0.4 } } : r,
    );

    renderer.render({
      gameTimeSec: 0,
      viewportWidth: 1280,
      viewportHeight: 800,
      camera,
      bodies: SOLAR_SYSTEM_BODIES,
      units: snap.ownUnits,
      faction: 'earth',
      ownWonder: wonderWithDamaged,
      routes: routesWithDetour,
    });

    expect(nonFiniteCount()).toBe(0);
    expect(texts.some((t) => t.startsWith('WP:earth-route-1'))).toBe(true);
    provider.dispose();
  });
});
