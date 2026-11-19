import { UNIT_CONFIGS } from '@space-war/shared';
import { describe, expect, it } from 'vitest';
import {
  HeadlessMatchRunner,
  applyUnitDamage,
  createUnitEntity,
} from '../src/index.js';

describe('SW-19 celestial mining, deep-space facilities, and pooled automatic logistics', () => {
  it('enforces geographical industrial-tier construction rules across home base, planets, and deep space', () => {
    const runner = new HeadlessMatchRunner();
    const world = runner.getWorldState();
    world.factions.earth.resources.ore = 2000;
    world.factions.earth.resources.propellant = 1000;

    // Cannot build mining outpost on home planets, Sun, deep space, or existing units
    expect(
      runner.submitCommand('earth', { type: 'queue_build', kind: 'outpost', targetRef: 'earth' }).accepted,
    ).toBe(false);
    expect(
      runner.submitCommand('earth', { type: 'queue_build', kind: 'outpost', targetRef: 'mars' }).accepted,
    ).toBe(false);
    expect(
      runner.submitCommand('earth', { type: 'queue_build', kind: 'outpost', targetRef: 'sun' }).accepted,
    ).toBe(false);
    expect(
      runner.submitCommand('earth', {
        type: 'queue_build',
        kind: 'outpost',
        targetRef: { x: 1.25, y: 0.25 },
      }).accepted,
    ).toBe(false);
    expect(
      runner.submitCommand('earth', {
        type: 'queue_build',
        kind: 'outpost',
        targetRef: 'earth-home-base',
      }).accepted,
    ).toBe(false);

    // Can build mining outpost on resource asteroid Eros
    expect(
      runner.submitCommand('earth', { type: 'queue_build', kind: 'outpost', targetRef: 'eros' }).accepted,
    ).toBe(true);

    // Cannot build warships off-world or in deep space; allowed at home base
    expect(
      runner.submitCommand('earth', {
        type: 'queue_build',
        kind: 'raider',
        targetRef: 'earth-outpost-venus',
      }).accepted,
    ).toBe(false);
    expect(
      runner.submitCommand('earth', {
        type: 'queue_build',
        kind: 'cruiser',
        targetRef: { x: 1.3, y: 0.1 },
      }).accepted,
    ).toBe(false);
    expect(
      runner.submitCommand('earth', { type: 'queue_build', kind: 'raider' }).accepted,
    ).toBe(true);

    // Cannot place relay depot on celestial bodies; allowed in deep-space orbit
    expect(
      runner.submitCommand('earth', { type: 'queue_build', kind: 'relay_depot', targetRef: 'earth' }).accepted,
    ).toBe(false);
    expect(
      runner.submitCommand('earth', {
        type: 'queue_build',
        kind: 'relay_depot',
        targetRef: { x: 1.24, y: 0.18 },
      }).accepted,
    ).toBe(true);
  });

  it('mines resources on celestial outposts, dispatches pooled freighters, and delivers cargo on arrival', () => {
    const runner = new HeadlessMatchRunner();
    const world = runner.getWorldState();

    // Pause other routes so we cleanly observe Venus -> Earth ore delivery
    runner.submitCommand('earth', {
      type: 'update_route',
      routeId: 'route-earth-mercury-ore',
      patch: { paused: true },
    });
    for (const r of world.routesByFaction.mars) {
      r.paused = true;
    }

    const startOre = world.factions.earth.resources.ore;
    const outpost = world.units.get('earth-outpost-venus')!;
    outpost.cargo = { ore: 95, propellant: 0 };

    // Step 6 seconds -> outpost accumulates ore past 100 and dispatches 1 pooled freighter
    runner.runTicks(60);
    expect(world.factions.earth.freightersInFlight).toBe(1);
    const inFlightFreighter = [...world.units.values()].find(
      (u) => u.faction === 'earth' && u.kind === 'freighter',
    );
    expect(inFlightFreighter).toBeDefined();

    // Step until freighter arrives at earth-home-base (within 180s)
    let delivered = false;
    for (let i = 0; i < 1800; i++) {
      runner.stepTick();
      if (world.factions.earth.resources.ore >= startOre + 100) {
        delivered = true;
        break;
      }
    }
    expect(delivered).toBe(true);
    // Freighter despawns upon delivery and frees capacity slot (may dispatch next if mined >=100)
    expect(world.units.has(inFlightFreighter!.id)).toBe(false);
  });

  it('permanently deducts 1 freighterCap and loses cargo when an in-flight freighter is destroyed', () => {
    const runner = new HeadlessMatchRunner();
    const world = runner.getWorldState();

    runner.submitCommand('earth', {
      type: 'update_route',
      routeId: 'route-earth-mercury-ore',
      patch: { paused: true },
    });
    const initialCap = world.factions.earth.freighterCap;
    const initialOre = world.factions.earth.resources.ore;

    runner.stepTick();
    expect(world.factions.earth.freightersInFlight).toBe(1);
    const freighter = [...world.units.values()].find(
      (u) => u.faction === 'earth' && u.kind === 'freighter',
    )!;
    expect(freighter).toBeDefined();

    applyUnitDamage(world, freighter, freighter.maxHp + 50);

    expect(world.units.has(freighter.id)).toBe(false);
    expect(world.factions.earth.freightersInFlight).toBe(0);
    expect(world.factions.earth.freighterCap).toBe(initialCap - 1);
    expect(world.factions.earth.resources.ore).toBe(initialOre);
  });

  it('honors paused, batchSize, detourWaypoint clearing & routing, and auto-binds escorts', () => {
    const runner = new HeadlessMatchRunner();
    const world = runner.getWorldState();

    // Pause route and verify no freighter dispatches even with full cargo
    runner.submitCommand('earth', {
      type: 'update_route',
      routeId: 'route-earth-venus-ore',
      patch: { paused: true, batchSize: 2 },
    });
    runner.submitCommand('earth', {
      type: 'update_route',
      routeId: 'route-earth-mercury-ore',
      patch: { paused: true },
    });

    const outpost = world.units.get('earth-outpost-venus')!;
    outpost.cargo = { ore: 220, propellant: 0 };
    runner.runTicks(20);
    expect(world.factions.earth.freightersInFlight).toBe(0);

    // Resume with batchSize = 2 -> dispatches 2 freighters simultaneously
    runner.submitCommand('earth', {
      type: 'update_route',
      routeId: 'route-earth-venus-ore',
      patch: { paused: false, batchSize: 2 },
    });
    runner.stepTick();
    expect(world.factions.earth.freightersInFlight).toBe(2);

    // Reset to batchSize = 1 with a deep-space detour waypoint and bound escort
    const runnerDetour = new HeadlessMatchRunner();
    const dw = runnerDetour.getWorldState();
    dw.factions.earth.freighterCap = 3;
    runnerDetour.submitCommand('earth', {
      type: 'update_route',
      routeId: 'route-earth-mercury-ore',
      patch: { paused: true },
    });

    const detourPoint = { x: 1.08, y: 0.35 };
    const setDetour = runnerDetour.submitCommand('earth', {
      type: 'update_route',
      routeId: 'route-earth-venus-ore',
      patch: {
        detourWaypoint: detourPoint,
        escortUnitIds: ['earth-raider-1'],
      },
    });
    expect(setDetour.accepted).toBe(true);

    const baseOre = dw.factions.earth.resources.ore;
    runnerDetour.stepTick();

    const raider = dw.units.get('earth-raider-1')!;
    expect(raider.plannedBurns.length).toBeGreaterThan(0);

    const freighter = [...dw.units.values()].find(
      (u) => u.faction === 'earth' && u.kind === 'freighter',
    )!;
    expect(freighter).toBeDefined();

    // Pause further launches so we cleanly trace this single detoured freighter
    runnerDetour.submitCommand('earth', {
      type: 'update_route',
      routeId: 'route-earth-venus-ore',
      patch: { paused: true },
    });

    let minDetourDist = Number.POSITIVE_INFINITY;
    let arrivedAfterDetour = false;
    for (let t = 0; t < 2400; t++) {
      runnerDetour.stepTick();
      const f = dw.units.get(freighter.id);
      if (f) {
        minDetourDist = Math.min(
          minDetourDist,
          Math.hypot(f.pos.x - detourPoint.x, f.pos.y - detourPoint.y),
        );
      } else if (dw.factions.earth.resources.ore >= baseOre + 100) {
        arrivedAfterDetour = true;
        break;
      }
    }

    expect(minDetourDist).toBeLessThanOrEqual(0.065);
    expect(arrivedAfterDetour).toBe(true);

    // Clearing detourWaypoint via undefined removes the field cleanly
    runnerDetour.submitCommand('earth', {
      type: 'update_route',
      routeId: 'route-earth-venus-ore',
      patch: { detourWaypoint: undefined },
    });
    const updatedRoute = dw.routesByFaction.earth.find((r) => r.id === 'route-earth-venus-ore')!;
    expect(updatedRoute.detourWaypoint).toBeUndefined();
  });

  it('refuels stranded friendly ships (deltaV === 0) from tankers and relay depots', () => {
    const runner = new HeadlessMatchRunner();
    const world = runner.getWorldState();
    world.units.clear();

    const tanker = createUnitEntity({
      id: 'e-tanker',
      faction: 'earth',
      kind: 'tanker',
      orbit: { a: 1.2, e: 0, omega: 0, meanAnomaly0: 1.0, epochSec: 0 },
    });
    const stranded = createUnitEntity({
      id: 'e-stranded',
      faction: 'earth',
      kind: 'raider',
      orbit: { a: 1.21, e: 0, omega: 0, meanAnomaly0: 1.0, epochSec: 0 },
    });
    stranded.deltaV = 0;

    world.units.set(tanker.id, tanker);
    world.units.set(stranded.id, stranded);

    // Run 30 ticks (3.0s) with propellant available -> raider recovers deltaV
    runner.runTicks(30);
    const rescued1 = world.units.get(stranded.id)!;
    expect(rescued1.deltaV).toBeGreaterThan(0.005);

    // Even at 0 global propellant, a field tanker can siphon its own reserve to rescue a stranded ship
    rescued1.deltaV = 0;
    world.factions.earth.resources.propellant = 0;
    const tankerDvBefore = world.units.get(tanker.id)!.deltaV;

    runner.runTicks(30);
    const rescued2 = world.units.get(stranded.id)!;
    const tankerAfter = world.units.get(tanker.id)!;
    expect(rescued2.deltaV).toBeGreaterThan(0.005);
    expect(tankerAfter.deltaV).toBeLessThan(tankerDvBefore);
    expect(UNIT_CONFIGS.tanker.logistics.canResupply).toBe(true);
  });
});
