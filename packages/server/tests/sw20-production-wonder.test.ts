import { UNIT_CONFIGS, WONDER_CONFIG, getBodyStateAt } from '@space-war/shared';
import { describe, expect, it } from 'vitest';
import {
  SimulationLoop,
  createFiveMinuteStartupWorldState,
  damageWonderSlot,
  getWonderSlotPosition,
} from '../src/index.js';

describe('SW-20 home-base production queue, 5-minute startup template, and 16-slot wonder victory', () => {
  it('starts five-minute template with zero mainline warships and launches an interplanetary strike within 5 min', () => {
    const world = createFiveMinuteStartupWorldState();
    const loop = new SimulationLoop(world);

    const earthUnits0 = [...world.units.values()].filter((u) => u.faction === 'earth');
    const marsUnits0 = [...world.units.values()].filter((u) => u.faction === 'mars');

    const isMainlineWarship = (kind: string) =>
      kind === 'raider' || kind === 'cruiser' || kind === 'escort_frigate';

    expect(earthUnits0.some((u) => isMainlineWarship(u.kind))).toBe(false);
    expect(marsUnits0.some((u) => isMainlineWarship(u.kind))).toBe(false);
    expect(earthUnits0.filter((u) => u.kind === 'mining_outpost')).toHaveLength(2);
    expect(marsUnits0.filter((u) => u.kind === 'mining_outpost')).toHaveLength(2);
    expect(world.routesByFaction.earth).toHaveLength(2);
    expect(world.routesByFaction.mars).toHaveLength(2);

    // Player queues a stealth raider at t = 0
    const buildRes = loop.submitCommand('earth', { type: 'queue_build', kind: 'raider' });
    expect(buildRes.accepted).toBe(true);

    // Advance 60 seconds (600 ticks): raider buildTimeSec = 54s completes
    for (let i = 0; i < 600; i++) {
      loop.stepTick();
    }

    const builtRaider = [...world.units.values()].find(
      (u) => u.faction === 'earth' && u.kind === 'raider',
    );
    expect(builtRaider).toBeDefined();

    // Order interplanetary transfer toward Eros before the 5-minute mark (300s)
    const interceptRes = loop.submitCommand('earth', {
      type: 'plan_intercept',
      unitId: builtRaider!.id,
      targetRefId: 'eros',
      mode: 'fast',
    });
    expect(interceptRes.accepted).toBe(true);

    // Advance to t = 300s (2400 more ticks): initial freighters have delivered ore & raider has burned
    for (let i = 0; i < 2400; i++) {
      loop.stepTick();
    }

    expect(world.gameTimeSec).toBeCloseTo(300, 4);
    expect(world.factions.earth.resources.ore).toBeGreaterThan(300);
    const raiderAt5m = world.units.get(builtRaider!.id)!;
    expect(raiderAt5m.deltaV).toBeLessThan(UNIT_CONFIGS.raider.maxDeltaV);
  });

  it('processes home-base queue for freighter_cap, outpost kits, and deep-space relay depots', () => {
    const loop = new SimulationLoop(createFiveMinuteStartupWorldState());
    const world = loop.world;
    world.factions.earth.resources.ore = 1000;
    world.factions.earth.resources.propellant = 500;

    expect(
      loop.submitCommand('earth', { type: 'queue_build', kind: 'freighter_cap' }).accepted,
    ).toBe(true);
    expect(
      loop.submitCommand('earth', { type: 'queue_build', kind: 'outpost', targetRef: 'eros' }).accepted,
    ).toBe(true);
    expect(
      loop.submitCommand('earth', {
        type: 'queue_build',
        kind: 'relay_depot',
        targetRef: { x: 1.25, y: 0.2 },
      }).accepted,
    ).toBe(true);

    // Max concurrent production = 2, so 3 items take ~75s total (45s + 50s staggered after 25s)
    for (let i = 0; i < 900; i++) {
      loop.stepTick();
    }

    expect(world.factions.earth.freighterCap).toBe(4);
    const erosOutpost = [...world.units.values()].find(
      (u) => u.faction === 'earth' && u.kind === 'mining_outpost' && world.outpostBodyByUnitId.get(u.id) === 'eros',
    );
    expect(erosOutpost).toBeDefined();
    expect(world.routesByFaction.earth.some((r) => r.sourceBodyId === 'eros')).toBe(true);

    const relayDepot = [...world.units.values()].find(
      (u) => u.faction === 'earth' && u.kind === 'relay_depot',
    );
    expect(relayDepot).toBeDefined();
  });

  it('rotates 16 co-orbital wonder slots with home planet, enforces concurrency/halting/repair, and triggers victory after stabilization', () => {
    const loop = new SimulationLoop(createFiveMinuteStartupWorldState());
    const world = loop.world;
    world.factions.earth.resources.ore = 2000;

    // 1. Co-orbital rotation check: slots stay ~1.0 AU and advance synchronously with Earth
    const slot0At0 = getWonderSlotPosition(world, 'earth', 0);
    const slot8At0 = getWonderSlotPosition(world, 'earth', 8);
    expect(Math.hypot(slot0At0.x, slot0At0.y)).toBeCloseTo(1.0, 1);
    // Slots 0 and 8 are on opposite sides of the solar ring (~2.0 AU separation)
    expect(Math.hypot(slot8At0.x - slot0At0.x, slot8At0.y - slot0At0.y)).toBeGreaterThan(1.9);

    world.gameTimeSec = 63; // 1/4 Earth year
    const earthAt63 = getBodyStateAt(world.celestials.find((b) => b.id === 'earth')!, 63).pos;
    const slot0At63 = getWonderSlotPosition(world, 'earth', 0);
    const angleEarth = Math.atan2(earthAt63.y, earthAt63.x);
    const angleSlot0 = Math.atan2(slot0At63.y, slot0At63.x);
    const pitch = (2 * Math.PI) / WONDER_CONFIG.slotCount;
    expect(Math.abs((angleSlot0 - angleEarth) - pitch * 0.5)).toBeLessThan(0.1);
    world.gameTimeSec = 0;

    // 2. Max 2 concurrent building slots enforced
    expect(loop.submitCommand('earth', { type: 'queue_build', kind: 'wonder_slot' }).accepted).toBe(true);
    expect(loop.submitCommand('earth', { type: 'queue_build', kind: 'wonder_slot' }).accepted).toBe(true);
    expect(loop.submitCommand('earth', { type: 'queue_build', kind: 'wonder_slot' }).accepted).toBe(false);

    // Advance 30s -> both slots progress
    for (let i = 0; i < 300; i++) {
      loop.stepTick();
    }
    const prog0BeforeHit = world.factions.earth.wonder[0]!.progressOre;
    const prog1BeforeHit = world.factions.earth.wonder[1]!.progressOre;
    expect(prog0BeforeHit).toBeGreaterThan(80);

    // 3. Enemy attacks slot 0 -> transitions to damaged_halted and pauses progress
    expect(damageWonderSlot(world, 'earth', 0, 220)).toBe(true);
    expect(world.factions.earth.wonder[0]!.status).toBe('damaged_halted');
    expect(world.factions.earth.wonder[0]!.hp).toBe(WONDER_CONFIG.slotMaxHp - 220);

    for (let i = 0; i < 100; i++) {
      loop.stepTick();
    }
    expect(world.factions.earth.wonder[0]!.progressOre).toBeCloseTo(prog0BeforeHit, 6);
    expect(world.factions.earth.wonder[1]!.progressOre).toBeGreaterThan(prog1BeforeHit);

    // Repair halted slot via queue_build -> restores hp and resumes building
    const oreBeforeRepair = world.factions.earth.resources.ore;
    expect(loop.submitCommand('earth', { type: 'queue_build', kind: 'wonder_slot' }).accepted).toBe(true);
    expect(world.factions.earth.wonder[0]!.status).toBe('building');
    expect(world.factions.earth.wonder[0]!.hp).toBe(WONDER_CONFIG.slotMaxHp);
    expect(world.factions.earth.resources.ore).toBe(
      oreBeforeRepair - Math.round(WONDER_CONFIG.orePerSlot * WONDER_CONFIG.repairOreRatio),
    );

    // 4. Complete all 16 slots and verify stabilizationHoldSec (60s) triggers winner
    for (let idx = 0; idx < 15; idx++) {
      world.factions.earth.wonder[idx]!.status = 'complete';
      world.factions.earth.wonder[idx]!.progressOre = WONDER_CONFIG.orePerSlot;
    }
    world.factions.earth.wonder[15]!.status = 'building';
    world.factions.earth.wonder[15]!.progressOre = WONDER_CONFIG.orePerSlot - 2;

    // Step 2s so slot 15 finishes; winner must still be null before 60s hold expires
    for (let i = 0; i < 20; i++) {
      loop.stepTick();
    }
    expect(world.factions.earth.wonder[15]!.status).toBe('complete');
    expect(world.winner).toBeNull();

    // Advance remaining 60s stabilization hold
    for (let i = 0; i < 605; i++) {
      loop.stepTick();
    }
    expect(world.winner).toBe('earth');
  });
});
