import {
  CELESTIAL_BODIES_BY_ID,
  SOLAR_SYSTEM_BODIES,
  applyImpulsiveBurn,
  orbitToState,
  stateToOrbit,
  type KeplerOrbit,
} from '@space-war/shared';
import { describe, expect, it } from 'vitest';
import {
  HeadlessMatchRunner,
  buildFactionSnapshot,
  createUnitEntity,
  evaluateSensorChannels,
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
  return base;
}

describe('SW-11 multi-channel sensors and authoritative fog-of-war engine', () => {
  it('never leaks undetected enemy positions in FactionSnapshot', () => {
    const world = createEmptyTestWorld();
    // Place an EMCON-silent Mars raider far from Earth recon corvette (> 1.5 AU)
    const earthScout = createUnitEntity({
      id: 'e-scout',
      faction: 'earth',
      kind: 'recon_corvette',
      orbit: { a: 1.0, e: 0, omega: 0, meanAnomaly0: 0, epochSec: 0 },
      emconSilent: true,
    });
    const marsStealth = createUnitEntity({
      id: 'm-raider',
      faction: 'mars',
      kind: 'raider',
      orbit: { a: 2.2, e: 0, omega: 0, meanAnomaly0: Math.PI * 0.85, epochSec: 0 },
      emconSilent: true,
    });

    world.units.set(earthScout.id, earthScout);
    world.units.set(marsStealth.id, marsStealth);
    stepSensorsAndFog(world);

    const earthSnap = buildFactionSnapshot(world, 'earth');
    expect(earthSnap.ownUnits.map((u) => u.id)).toEqual(['e-scout']);
    expect(earthSnap.tracks).toHaveLength(0);

    const serialized = JSON.stringify(earthSnap);
    expect(serialized).not.toContain('m-raider');
    expect(serialized).not.toContain(String(marsStealth.pos.x));
  });

  it('detects enemy active radar via long-range passive ESM (1/R^2) as bearing before radar (1/R^4) sees back', () => {
    const world = createEmptyTestWorld();
    // Place on +Y axis (pi/2) away from Earth at (0.983, 0). Separation = 0.90 AU.
    const earthScout = createUnitEntity({
      id: 'e-scout',
      faction: 'earth',
      kind: 'recon_corvette',
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

    world.units.set(earthScout.id, earthScout);
    world.units.set(marsCruiser.id, marsCruiser);

    const ch = evaluateSensorChannels(earthScout, marsCruiser, world);
    expect(ch.snrEsm).toBeGreaterThanOrEqual(1.0);

    stepSensorsAndFog(world);

    const earthSnap = buildFactionSnapshot(world, 'earth');
    const marsSnap = buildFactionSnapshot(world, 'mars');

    expect(earthSnap.tracks).toHaveLength(1);
    const esmTrack = earthSnap.tracks[0]!;
    expect(esmTrack.confidence).toBe('bearing');
    expect(esmTrack.bearingRad).toBeDefined();
    expect(esmTrack.originPos).toBeDefined();
    // Bearing track must NOT leak true coordinates or orbit
    expect(esmTrack.pos).toBeUndefined();
    expect(esmTrack.vel).toBeUndefined();
    expect(esmTrack.estimatedOrbit).toBeUndefined();

    // Mars cruiser radar cannot see silent Earth scout at 0.9 AU
    expect(marsSnap.tracks).toHaveLength(0);
  });

  it('zeroes passive optical inside umbra and attenuates sensitivity under solar glare', () => {
    const world = createEmptyTestWorld();
    const earthPos = orbitToState(CELESTIAL_BODIES_BY_ID.earth!.orbit!, 0).pos;

    // Observer at (0.85, 0) looking outward at silent ship in Earth's umbra (1.1, 0)
    const obsOrbit: KeplerOrbit = { a: 0.85, e: 0, omega: 0, meanAnomaly0: 0, epochSec: 0 };
    const observer = createUnitEntity({
      id: 'e-obs',
      faction: 'earth',
      kind: 'recon_corvette',
      orbit: obsOrbit,
      emconSilent: true,
    });

    const umbraOrbit: KeplerOrbit = { a: 1.1, e: 0, omega: 0, meanAnomaly0: 0, epochSec: 0 };
    const inUmbraTarget = createUnitEntity({
      id: 'm-umbra',
      faction: 'mars',
      kind: 'cruiser',
      orbit: umbraOrbit,
      emconSilent: true,
    });

    // Ensure Earth does not occlude if we move observer slightly off axis into Earth's umbra flank
    observer.pos = { x: earthPos.x + 0.08, y: 0.05 };
    inUmbraTarget.pos = { x: earthPos.x + 0.12, y: 0 };
    const umbraCheck = evaluateSensorChannels(observer, inUmbraTarget, world);
    expect(umbraCheck.inUmbra).toBe(true);
    expect(umbraCheck.snrOptical).toBe(0);

    // Solar glare: observer at (0, 1.0) looking across Sun-side target (0, 0.55) vs away from Sun (0, 1.45)
    observer.pos = { x: 0, y: 1.0 };
    const sunwardTarget = createUnitEntity({
      id: 'm-sunward',
      faction: 'mars',
      kind: 'cruiser',
      orbit: { a: 0.55, e: 0, omega: 0, meanAnomaly0: Math.PI / 2, epochSec: 0 },
      emconSilent: true,
    });
    const antiSunTarget = createUnitEntity({
      id: 'm-antisun',
      faction: 'mars',
      kind: 'cruiser',
      orbit: { a: 1.45, e: 0, omega: 0, meanAnomaly0: Math.PI / 2, epochSec: 0 },
      emconSilent: true,
    });
    const glareEval = evaluateSensorChannels(observer, sunwardTarget, world);
    const clearEval = evaluateSensorChannels(observer, antiSunTarget, world);
    expect(glareEval.glareFactor).toBeLessThan(0.5);
    expect(clearEval.glareFactor).toBe(1);
    expect(glareEval.snrOptical).toBeLessThan(clearEval.snrOptical);
  });

  it('confirms targets via short-range directional LADAR and alerts the swept target', () => {
    const world = createEmptyTestWorld();
    const frigate = createUnitEntity({
      id: 'e-frigate',
      faction: 'earth',
      kind: 'escort_frigate',
      orbit: { a: 1.0, e: 0, omega: 0, meanAnomaly0: Math.PI / 2, epochSec: 0 },
      emconSilent: false,
    });
    // Place Mars stealth raider 0.030 AU ahead (within frigate ladarRangeAu = 0.035),
    // with sensor subsystem damaged & blinded so it wouldn't confirm frigate without LADAR alert
    const marsRaider = createUnitEntity({
      id: 'm-raider',
      faction: 'mars',
      kind: 'raider',
      orbit: { a: 1.03, e: 0, omega: 0, meanAnomaly0: Math.PI / 2, epochSec: 0 },
      emconSilent: true,
    });
    marsRaider.subsystems.sensors = 'damaged';
    world.sensorBlindUntilSec.set(marsRaider.id, 10);
    const angle = Math.atan2(marsRaider.pos.y - frigate.pos.y, marsRaider.pos.x - frigate.pos.x);
    frigate.ladarTargetAngle = angle;

    world.units.set(frigate.id, frigate);
    world.units.set(marsRaider.id, marsRaider);
    stepSensorsAndFog(world);

    const earthSnap = buildFactionSnapshot(world, 'earth');
    const marsSnap = buildFactionSnapshot(world, 'mars');

    expect(earthSnap.tracks).toHaveLength(1);
    expect(earthSnap.tracks[0]!.confidence).toBe('confirmed');
    expect(earthSnap.tracks[0]!.pos?.x).toBeCloseTo(marsRaider.pos.x, 8);

    // Swept Mars raider gets a passive laser-warning bearing track back toward the frigate
    expect(marsSnap.tracks.some((t) => t.confidence === 'bearing')).toBe(true);
  });

  it('maintains stale ghost extrapolation on pre-burn orbit when target maneuvers inside occlusion', () => {
    const world = createEmptyTestWorld();
    world.celestials = SOLAR_SYSTEM_BODIES;

    // Step 1: Earth frigate confirms Mars raider at close range before occlusion (+Y axis away from Earth)
    const earthObs = createUnitEntity({
      id: 'e-obs',
      faction: 'earth',
      kind: 'escort_frigate',
      orbit: { a: 1.0, e: 0, omega: 0, meanAnomaly0: Math.PI / 2, epochSec: 0 },
      radarActive: true,
    });
    const preBurnOrbit: KeplerOrbit = {
      a: 1.12,
      e: 0,
      omega: 0,
      meanAnomaly0: Math.PI / 2,
      epochSec: 0,
    };
    const marsRaider = createUnitEntity({
      id: 'm-raider',
      faction: 'mars',
      kind: 'raider',
      orbit: preBurnOrbit,
      emconSilent: true,
    });

    world.units.set(earthObs.id, earthObs);
    world.units.set(marsRaider.id, marsRaider);
    stepSensorsAndFog(world);

    const initialEarth = buildFactionSnapshot(world, 'earth');
    expect(initialEarth.tracks[0]?.confidence).toBe('confirmed');

    // Step 2: Move Mars raider behind the Sun relative to Earth observer & execute a major burn
    const tLater = 10;
    world.gameTimeSec = tLater;
    world.tick = 100;

    // Put Earth observer at (1.0, 0) and Mars raider behind the Sun at (-0.8, 0)
    earthObs.pos = { x: 1.0, y: 0 };
    const occludedPreBurnPos = { x: -0.8, y: 0 };
    const occludedPreBurnVel = { x: 0, y: -0.025 };
    const occludedOrbit = stateToOrbit(occludedPreBurnPos, occludedPreBurnVel, tLater);
    // Reset track memory lastConfirmedOrbit to that pre-burn orbit just before entering occlusion
    world.trackMemoryByFaction.earth.get('m-raider')!.lastConfirmedOrbit = occludedOrbit;

    // Now Mars raider burns strongly inside the Sun's occlusion cone to a totally different trajectory
    const burned = applyImpulsiveBurn(
      { pos: occludedPreBurnPos, vel: occludedPreBurnVel },
      { x: 0, y: -0.008 },
      marsRaider.deltaV,
      tLater,
    );
    marsRaider.pos = burned.state.pos;
    marsRaider.vel = burned.state.vel;
    marsRaider.orbit = burned.orbit;

    // Propagate both real ship and world clock +1.0s while still inside the Sun's occlusion cone
    const tCheck = tLater + 1.0;
    world.gameTimeSec = tCheck;
    world.tick = 110;
    const realMarsLater = orbitToState(marsRaider.orbit, tCheck);
    marsRaider.pos = realMarsLater.pos;
    marsRaider.vel = realMarsLater.vel;

    // Ensure line of sight is occluded by the Sun at tCheck
    expect(evaluateSensorChannels(earthObs, marsRaider, world).occluded).toBe(true);

    stepSensorsAndFog(world);
    const snapAfterBurn = buildFactionSnapshot(world, 'earth');
    expect(snapAfterBurn.tracks).toHaveLength(1);

    const ghostTrack = snapAfterBurn.tracks[0]!;
    expect(ghostTrack.confidence).toBe('ghost');

    const expectedGhostPos = orbitToState(occludedOrbit, tCheck).pos;
    expect(ghostTrack.pos!.x).toBeCloseTo(expectedGhostPos.x, 8);
    expect(ghostTrack.pos!.y).toBeCloseTo(expectedGhostPos.y, 8);

    // Ghost must diverge from the real post-burn position (proving no ground-truth leak!)
    const separation = Math.hypot(
      ghostTrack.pos!.x - marsRaider.pos.x,
      ghostTrack.pos!.y - marsRaider.pos.y,
    );
    expect(separation).toBeGreaterThan(0.005);
  });
});
