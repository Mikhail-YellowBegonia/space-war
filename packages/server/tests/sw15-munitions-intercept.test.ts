import { MUNITION_CONFIGS } from '@space-war/shared';
import { describe, expect, it } from 'vitest';
import {
  HeadlessMatchRunner,
  createUnitEntity,
  stepSensorsAndFog,
  type WorldState,
} from '../src/index.js';

function createCleanCombatRunner(): HeadlessMatchRunner {
  const runner = new HeadlessMatchRunner();
  const world: WorldState = runner.getWorldState();
  world.units.clear();
  world.munitions.clear();
  world.munitionMeta.clear();
  world.tracksByFaction.earth = [];
  world.tracksByFaction.mars = [];
  world.trackMemoryByFaction.earth.clear();
  world.trackMemoryByFaction.mars.clear();
  return runner;
}

describe('SW-15 unified munition system and big-map anti-missile interception', () => {
  it('enforces authoritative track-only firing rules and rejects bearing-only or unknown tracks', () => {
    const runner = createCleanCombatRunner();
    const world = runner.getWorldState();

    const earthCruiser = createUnitEntity({
      id: 'e-cruiser',
      faction: 'earth',
      kind: 'cruiser',
      orbit: { a: 1.0, e: 0, omega: 0, meanAnomaly0: Math.PI / 2, epochSec: 0 },
      emconSilent: true,
    });
    const marsCruiser = createUnitEntity({
      id: 'm-cruiser',
      faction: 'mars',
      kind: 'cruiser',
      orbit: { a: 1.9, e: 0, omega: 0, meanAnomaly0: Math.PI / 2, epochSec: 0 },
      radarActive: true,
    });
    world.units.set(earthCruiser.id, earthCruiser);
    world.units.set(marsCruiser.id, marsCruiser);
    stepSensorsAndFog(world);

    // Earth has only a bearing track on Mars cruiser via long-range ESM -> firing must be rejected
    const earthSnap = runner.getSnapshot('earth');
    expect(earthSnap.tracks).toHaveLength(1);
    expect(earthSnap.tracks[0]!.confidence).toBe('bearing');

    const bearingFire = runner.submitCommand('earth', {
      type: 'fire_munition',
      unitId: 'e-cruiser',
      targetTrackId: earthSnap.tracks[0]!.trackId,
      profileId: 'heavy_torpedo',
      count: 1,
      coldCoast: true,
    });
    expect(bearingFire.accepted).toBe(false);

    // Raw enemy entity ID must also be rejected
    const rawIdFire = runner.submitCommand('earth', {
      type: 'fire_munition',
      unitId: 'e-cruiser',
      targetTrackId: 'm-cruiser',
      profileId: 'heavy_torpedo',
      count: 1,
      coldCoast: true,
    });
    expect(rawIdFire.accepted).toBe(false);
  });

  it('launches a heavy torpedo in cold-coast, activates terminal seeker, and hits the target ship', () => {
    const runner = createCleanCombatRunner();
    const world = runner.getWorldState();

    const earthCruiser = createUnitEntity({
      id: 'e-cruiser',
      faction: 'earth',
      kind: 'cruiser',
      orbit: { a: 1.0, e: 0, omega: 0, meanAnomaly0: Math.PI / 2, epochSec: 0 },
      radarActive: true,
    });
    // Mars frigate at 0.24 AU (confirmed by cruiser radar, outside torpedo seekerRangeAu=0.14)
    const marsFrigate = createUnitEntity({
      id: 'm-frigate',
      faction: 'mars',
      kind: 'escort_frigate',
      orbit: { a: 1.24, e: 0, omega: 0, meanAnomaly0: Math.PI / 2, epochSec: 0 },
      emconSilent: true,
    });
    world.units.set(earthCruiser.id, earthCruiser);
    world.units.set(marsFrigate.id, marsFrigate);
    stepSensorsAndFog(world);

    const earthSnap = runner.getSnapshot('earth');
    const track = earthSnap.tracks.find((t) => t.confidence === 'confirmed');
    expect(track).toBeDefined();

    const initialHp = marsFrigate.hp;
    const fireRes = runner.submitCommand('earth', {
      type: 'fire_munition',
      unitId: 'e-cruiser',
      targetTrackId: track!.trackId,
      profileId: 'heavy_torpedo',
      count: 1,
      coldCoast: true,
    });
    expect(fireRes.accepted).toBe(true);
    expect(runner.getSnapshot('earth').ownMunitions).toHaveLength(1);
    expect(runner.getSnapshot('earth').ownMunitions[0]!.coldCoast).toBe(true);

    let sawColdCoast = false;
    let sawTerminalActivation = false;
    let hitObserved = false;

    for (let i = 0; i < 700; i++) {
      runner.stepTick();
      const torp = world.munitions.get('earth-mun-1');
      if (torp && torp.coldCoast) {
        sawColdCoast = true;
      }
      if (torp && !torp.coldCoast) {
        sawTerminalActivation = true;
      }
      if (world.units.get('m-frigate')!.hp < initialHp) {
        hitObserved = true;
        break;
      }
    }

    expect(sawColdCoast).toBe(true);
    expect(sawTerminalActivation).toBe(true);
    expect(hitObserved).toBe(true);
    expect(world.units.get('m-frigate')!.hp).toBeCloseTo(
      initialHp - MUNITION_CONFIGS.heavy_torpedo.damage,
      6,
    );
  });

  it('intercepts an incoming enemy heavy torpedo mid-flight using a light interceptor', () => {
    const runner = createCleanCombatRunner();
    const world = runner.getWorldState();

    const earthCruiser = createUnitEntity({
      id: 'e-cruiser',
      faction: 'earth',
      kind: 'cruiser',
      orbit: { a: 1.0, e: 0, omega: 0, meanAnomaly0: Math.PI / 2, epochSec: 0 },
      radarActive: true,
    });
    const marsFrigate = createUnitEntity({
      id: 'm-frigate',
      faction: 'mars',
      kind: 'escort_frigate',
      orbit: { a: 1.24, e: 0, omega: 0, meanAnomaly0: Math.PI / 2, epochSec: 0 },
      radarActive: true,
    });
    world.units.set(earthCruiser.id, earthCruiser);
    world.units.set(marsFrigate.id, marsFrigate);
    stepSensorsAndFog(world);

    const earthTrack = runner.getSnapshot('earth').tracks.find((t) => t.confidence === 'confirmed')!;
    const marsFrigateInitialHp = marsFrigate.hp;

    // Earth launches a heavy torpedo
    const fireTorp = runner.submitCommand('earth', {
      type: 'fire_munition',
      unitId: 'e-cruiser',
      targetTrackId: earthTrack.trackId,
      profileId: 'heavy_torpedo',
      count: 1,
      coldCoast: false,
    });
    expect(fireTorp.accepted).toBe(true);

    // Advance until Mars detects the incoming torpedo track and launches a light interceptor
    let interceptorLaunched = false;
    let torpedoIntercepted = false;

    for (let i = 0; i < 350; i++) {
      runner.stepTick();
      if (!interceptorLaunched) {
        const marsSnap = runner.getSnapshot('mars');
        const torpTrack = marsSnap.tracks.find(
          (t) =>
            t.suspectedKind === 'munition' &&
            (t.confidence === 'confirmed' || t.confidence === 'uncertain'),
        );
        if (torpTrack) {
          const fireInt = runner.submitCommand('mars', {
            type: 'fire_munition',
            unitId: 'm-frigate',
            targetTrackId: torpTrack.trackId,
            profileId: 'light_interceptor',
            count: 1,
            coldCoast: false,
          });
          expect(fireInt.accepted).toBe(true);
          interceptorLaunched = true;
        }
      }

      const torp = world.munitions.get('earth-mun-1');
      if (interceptorLaunched && (!torp || torp.intercepted)) {
        torpedoIntercepted = true;
        break;
      }
    }

    expect(interceptorLaunched).toBe(true);
    expect(torpedoIntercepted).toBe(true);
    expect(world.units.get('m-frigate')!.hp).toBe(marsFrigateInitialHp);
  });

  it('allows active RF jamming and EW decoy drones to spoof or break terminal missile lock', () => {
    const runner = createCleanCombatRunner();
    const world = runner.getWorldState();

    const earthCruiser = createUnitEntity({
      id: 'e-cruiser',
      faction: 'earth',
      kind: 'cruiser',
      orbit: { a: 1.0, e: 0, omega: 0, meanAnomaly0: Math.PI / 2, epochSec: 0 },
      radarActive: true,
    });
    const marsCruiser = createUnitEntity({
      id: 'm-cruiser',
      faction: 'mars',
      kind: 'cruiser',
      orbit: { a: 1.24, e: 0, omega: 0, meanAnomaly0: Math.PI / 2, epochSec: 0 },
      emconSilent: false,
    });
    // Mars deploys an active EW decoy drone nearby
    const marsDecoy = createUnitEntity({
      id: 'm-decoy',
      faction: 'mars',
      kind: 'drone_ew',
      orbit: { a: 1.23, e: 0, omega: 0, meanAnomaly0: Math.PI / 2 + 0.015, epochSec: 0 },
      emconSilent: false,
      radarActive: true,
      jammerActive: true,
    });

    world.units.set(earthCruiser.id, earthCruiser);
    world.units.set(marsCruiser.id, marsCruiser);
    world.units.set(marsDecoy.id, marsDecoy);
    stepSensorsAndFog(world);

    // Earth locks onto Mars cruiser track (or uncertain track under jamming) and fires heavy torpedo
    const marsTrack = runner.getSnapshot('earth').tracks.find(
      (t) => t.confidence === 'confirmed' || t.confidence === 'uncertain',
    )!;
    expect(marsTrack).toBeDefined();

    const initialMarsCruiserHp = marsCruiser.hp;
    const fire = runner.submitCommand('earth', {
      type: 'fire_munition',
      unitId: 'e-cruiser',
      targetTrackId: marsTrack.trackId,
      profileId: 'heavy_torpedo',
      count: 1,
      coldCoast: false,
    });
    expect(fire.accepted).toBe(true);

    let distractedByDecoy = false;
    for (let i = 0; i < 300; i++) {
      runner.stepTick();
      const meta = world.munitionMeta.get('earth-mun-1');
      if (meta?.decoyDistractedId === 'm-decoy') {
        distractedByDecoy = true;
        break;
      }
    }

    expect(distractedByDecoy).toBe(true);
    expect(world.units.get('m-cruiser')!.hp).toBe(initialMarsCruiserHp);
  });
});
