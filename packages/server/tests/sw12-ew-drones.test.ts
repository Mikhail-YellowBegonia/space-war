import { UNIT_CONFIGS } from '@space-war/shared';
import { describe, expect, it } from 'vitest';
import {
  EW_CONSTANTS,
  HeadlessMatchRunner,
  SENSOR_CONSTANTS,
  buildFactionSnapshot,
  createUnitEntity,
  evaluateSensorChannels,
  stepEwSystem,
  stepSensorsAndFog,
  type WorldState,
} from '../src/index.js';

function createEmptyTestWorld(): WorldState {
  const base = new HeadlessMatchRunner().getWorldState();
  base.units.clear();
  base.munitions.clear();
  base.tracksByFaction.earth = [];
  base.tracksByFaction.mars = [];
  base.trackMemoryByFaction.earth.clear();
  base.trackMemoryByFaction.mars.clear();
  base.sensorBlindUntilSec.clear();
  base.launchedDronesByCarrier.clear();
  return base;
}

describe('SW-12 electronic warfare jamming, dazzling laser, and drones', () => {
  it('degrades enemy radar lock from confirmed to uncertain with expanded error ellipse when jammer is active', () => {
    const world = createEmptyTestWorld();
    const earthFrigate = createUnitEntity({
      id: 'e-frigate',
      faction: 'earth',
      kind: 'escort_frigate',
      orbit: { a: 1.0, e: 0, omega: 0, meanAnomaly0: Math.PI / 2, epochSec: 0 },
      radarActive: true,
    });
    const marsCruiser = createUnitEntity({
      id: 'm-cruiser',
      faction: 'mars',
      kind: 'cruiser',
      orbit: { a: 1.28, e: 0, omega: 0, meanAnomaly0: Math.PI / 2, epochSec: 0 },
      emconSilent: false,
    });

    world.units.set(earthFrigate.id, earthFrigate);
    world.units.set(marsCruiser.id, marsCruiser);
    stepSensorsAndFog(world);

    const beforeJam = buildFactionSnapshot(world, 'earth').tracks[0]!;
    expect(beforeJam.confidence).toBe('confirmed');
    expect(beforeJam.isJammed).toBe(false);
    const baseMajor = beforeJam.errorRadiusMajorAu ?? 0.002;

    // Mars activates RF jammer
    marsCruiser.jammerActive = true;
    stepSensorsAndFog(world);

    const afterJam = buildFactionSnapshot(world, 'earth').tracks[0]!;
    expect(afterJam.confidence).toBe('uncertain');
    expect(afterJam.isJammed).toBe(true);
    expect(afterJam.errorRadiusMajorAu!).toBeGreaterThanOrEqual(
      baseMajor * SENSOR_CONSTANTS.jammerErrorMultiplier,
    );

    // Jamming exposes Mars cruiser via long-range passive ESM even to a distant Earth scout
    const distantScout = createUnitEntity({
      id: 'e-distant',
      faction: 'earth',
      kind: 'recon_corvette',
      orbit: { a: 2.4, e: 0, omega: 0, meanAnomaly0: Math.PI / 2, epochSec: 0 },
      emconSilent: true,
    });
    const ch = evaluateSensorChannels(distantScout, marsCruiser, world);
    expect(ch.snrEsm).toBeGreaterThan(1.0);
  });

  it('suppresses enemy optical/IR sensors temporarily via blinding laser dazzle and recovers after expiry', () => {
    const world = createEmptyTestWorld();
    const earthFrigate = createUnitEntity({
      id: 'e-frigate',
      faction: 'earth',
      kind: 'escort_frigate',
      orbit: { a: 1.0, e: 0, omega: 0, meanAnomaly0: Math.PI / 2, epochSec: 0 },
      emconSilent: false,
    });
    // Place Mars raider within laserRangeAu (0.025 AU)
    const marsRaider = createUnitEntity({
      id: 'm-raider',
      faction: 'mars',
      kind: 'raider',
      orbit: { a: 1.02, e: 0, omega: 0, meanAnomaly0: Math.PI / 2, epochSec: 0 },
      emconSilent: false,
    });

    earthFrigate.ladarTargetAngle = Math.atan2(
      marsRaider.pos.y - earthFrigate.pos.y,
      marsRaider.pos.x - earthFrigate.pos.x,
    );

    world.units.set(earthFrigate.id, earthFrigate);
    world.units.set(marsRaider.id, marsRaider);

    const preBlind = evaluateSensorChannels(marsRaider, earthFrigate, world);
    expect(preBlind.snrOptical).toBeGreaterThan(0);

    stepEwSystem(world, 0.1);
    expect(world.vfxEvents.some((ev) => ev.kind === 'laser')).toBe(true);
    expect(world.sensorBlindUntilSec.get(marsRaider.id)).toBeCloseTo(
      EW_CONSTANTS.dazzleDurationSec,
      6,
    );

    const whileBlinded = evaluateSensorChannels(marsRaider, earthFrigate, world);
    expect(whileBlinded.snrOptical).toBeCloseTo(
      preBlind.snrOptical * SENSOR_CONSTANTS.dazzleSuppressionFactor,
      8,
    );
    expect(whileBlinded.snrIr).toBeCloseTo(
      preBlind.snrIr * SENSOR_CONSTANTS.dazzleSuppressionFactor,
      8,
    );

    // Turn off LADAR sweep on the authoritative world unit, advance past dazzle duration, and confirm recovery
    const latestFrigate = world.units.get(earthFrigate.id)!;
    world.units.set(earthFrigate.id, { ...latestFrigate, ladarTargetAngle: undefined });
    world.gameTimeSec = EW_CONSTANTS.dazzleDurationSec + 0.5;
    stepEwSystem(world, 0.1);
    expect(world.sensorBlindUntilSec.has(marsRaider.id)).toBe(false);
    const afterRecovery = evaluateSensorChannels(marsRaider, latestFrigate, world);
    expect(afterRecovery.snrOptical).toBeCloseTo(preBlind.snrOptical, 8);
  });

  it('triangulates a firing thermal target from bearing to confirmed using dual radar-off platforms', () => {
    const world = createEmptyTestWorld();
    const irByUnit = new Map<string, number>();

    // Target Mars nuclear cruiser firing far away (no radar on any Earth unit)
    const marsCruiser = createUnitEntity({
      id: 'm-cruiser',
      faction: 'mars',
      kind: 'cruiser',
      orbit: { a: 1.52, e: 0, omega: 0, meanAnomaly0: Math.PI / 2, epochSec: 0 },
      emconSilent: false,
    });
    // High nuclear burn IR signature visible system-wide
    irByUnit.set(marsCruiser.id, 520);

    // Single Earth recon corvette with radar OFF -> bearing-only
    const earthScout = createUnitEntity({
      id: 'e-scout',
      faction: 'earth',
      kind: 'recon_corvette',
      orbit: { a: 1.0, e: 0, omega: 0, meanAnomaly0: Math.PI / 2, epochSec: 0 },
      emconSilent: true,
    });

    world.units.set(marsCruiser.id, marsCruiser);
    world.units.set(earthScout.id, earthScout);
    stepSensorsAndFog(world, irByUnit);

    const singleTrack = buildFactionSnapshot(world, 'earth').tracks[0]!;
    expect(singleTrack.confidence).toBe('bearing');
    expect(singleTrack.pos).toBeUndefined();

    // Deploy a recon drone on an offset baseline (> 5 deg parallax) still with radar OFF
    const reconDrone = createUnitEntity({
      id: 'e-scout-drone_recon-1',
      faction: 'earth',
      kind: 'drone_recon',
      orbit: { a: 1.05, e: 0, omega: 0, meanAnomaly0: Math.PI / 2 + 0.3, epochSec: 0 },
      emconSilent: true,
    });
    world.units.set(reconDrone.id, reconDrone);

    stepSensorsAndFog(world, irByUnit);
    const triTrack = buildFactionSnapshot(world, 'earth').tracks[0]!;
    expect(triTrack.confidence).toBe('confirmed');
    expect(triTrack.pos).toBeDefined();
    expect(triTrack.pos!.x).toBeCloseTo(marsCruiser.pos.x, 4);
    expect(triTrack.pos!.y).toBeCloseTo(marsCruiser.pos.y, 4);
  });

  it('launches recon/EW drones via command pipeline, enforces bay capacity, and uses EW decoy + forward jammer', () => {
    const runner = new HeadlessMatchRunner();
    const world = runner.getWorldState();
    world.units.clear();
    world.tracksByFaction.earth = [];
    world.tracksByFaction.mars = [];
    world.trackMemoryByFaction.earth.clear();
    world.trackMemoryByFaction.mars.clear();

    const raider = createUnitEntity({
      id: 'e-raider',
      faction: 'earth',
      kind: 'raider',
      orbit: { a: 1.0, e: 0, omega: 0, meanAnomaly0: Math.PI / 2, epochSec: 0 },
      emconSilent: true,
    });
    const marsFrigate = createUnitEntity({
      id: 'm-frigate',
      faction: 'mars',
      kind: 'escort_frigate',
      orbit: { a: 1.24, e: 0, omega: 0, meanAnomaly0: Math.PI / 2, epochSec: 0 },
      radarActive: true,
    });
    world.units.set(raider.id, raider);
    world.units.set(marsFrigate.id, marsFrigate);

    // Raider has droneCapacity = 2
    expect(UNIT_CONFIGS.raider.weapons.droneCapacity).toBe(2);

    const launch1 = runner.submitCommand('earth', {
      type: 'launch_drone',
      unitId: 'e-raider',
      droneKind: 'drone_ew',
    });
    expect(launch1.accepted).toBe(true);

    const launch2 = runner.submitCommand('earth', {
      type: 'launch_drone',
      unitId: 'e-raider',
      droneKind: 'drone_recon',
      targetOrbit: { a: 1.08, e: 0.05, omega: 0.2, meanAnomaly0: 0, epochSec: 0 },
    });
    expect(launch2.accepted).toBe(true);

    // 3rd launch exceeds drone bay capacity
    const launch3 = runner.submitCommand('earth', {
      type: 'launch_drone',
      unitId: 'e-raider',
      droneKind: 'drone_recon',
    });
    expect(launch3.accepted).toBe(false);

    runner.stepTick();

    const marsSnapBeforeJam = runner.getSnapshot('mars');
    const decoyTrack = marsSnapBeforeJam.tracks.find((t) => t.suspectedKind === 'ship');
    // Mars frigate detects EW decoy drone as a 'ship'-like confirmed radar target
    expect(decoyTrack).toBeDefined();
    expect(decoyTrack!.confidence).toBe('confirmed');

    // Enable jammer on launched EW drone -> degrades Mars radar lock on the screen
    const ewDroneId = 'e-raider-drone_ew-1';
    const jamCmd = runner.submitCommand('earth', {
      type: 'set_emcon',
      unitId: ewDroneId,
      silent: false,
      radiatorsOpen: true,
      radarActive: true,
      jammerActive: true,
    });
    expect(jamCmd.accepted).toBe(true);

    runner.stepTick();
    const marsSnapAfterJam = runner.getSnapshot('mars');
    expect(marsSnapAfterJam.tracks.some((t) => t.isJammed && t.confidence === 'uncertain')).toBe(
      true,
    );
  });
});
