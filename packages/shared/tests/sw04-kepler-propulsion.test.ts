import { describe, expect, it } from 'vitest';
import {
  CELESTIAL_BODIES_BY_ID,
  MU_SUN,
  PROPULSION_CONFIGS,
  UNIT_CONFIGS,
  advanceUnitOrbit,
  applyImpulsiveBurn,
  getOrbitalPeriodSec,
  getPropulsionThrustFactor,
  getSpecificOrbitalEnergy,
  orbitToState,
  stateToOrbit,
  stepContinuousThrust,
  type KeplerOrbit,
  type PropulsionType,
  type UnitEntity,
} from '../src/index.js';

function makeTestUnit(propulsion: PropulsionType, deltaV?: number): UnitEntity {
  const kind =
    propulsion === 'nuclear'
      ? 'cruiser'
      : propulsion === 'electric'
        ? 'recon_corvette'
        : 'raider';
  const cfg = UNIT_CONFIGS[kind];
  const orbit: KeplerOrbit = {
    a: 1.0,
    e: 0,
    omega: 0,
    meanAnomaly0: 0,
    epochSec: 0,
  };
  const state = orbitToState(orbit, 0);
  const dv = deltaV ?? cfg.maxDeltaV;
  return {
    id: `test-${propulsion}`,
    faction: 'earth',
    kind,
    propulsion,
    pos: state.pos,
    vel: state.vel,
    orbit,
    hp: cfg.maxHp,
    maxHp: cfg.maxHp,
    subsystems: {
      propulsion: 'normal',
      sensors: 'normal',
      weapons: 'normal',
      thermal: 'normal',
    },
    deltaV: dv,
    maxDeltaV: cfg.maxDeltaV,
    heat: 0,
    maxHeat: cfg.maxHeat,
    radiatorsOpen: true,
    emconSilent: false,
    radarActive: false,
    jammerActive: false,
    ammoStock: cfg.weapons.ammoCapacity,
    plannedBurns: [],
  };
}

describe('SW-04 two-body Kepler engine and propulsion models', () => {
  it('round-trips orbitToState and stateToOrbit across circular, near-circular, and eccentric orbits', () => {
    const orbits: KeplerOrbit[] = [
      { a: 1.0, e: 0, omega: 0, meanAnomaly0: 0.75, epochSec: 10 },
      { a: 1.25, e: 1e-7, omega: 1.2, meanAnomaly0: 2.3, epochSec: 0 },
      { a: 1.52, e: 0.093, omega: 0.2, meanAnomaly0: 0.75, epochSec: 0 },
      { a: 2.77, e: 0.231, omega: 4.5, meanAnomaly0: 5.3, epochSec: 0 },
      { a: 1.9, e: 0.75, omega: 2.8, meanAnomaly0: 1.1, epochSec: 42 },
    ];

    for (const orbit of orbits) {
      const t = orbit.epochSec + 37.5;
      const state = orbitToState(orbit, t);
      const recovered = stateToOrbit(state.pos, state.vel, t);
      const stateAfter = orbitToState(recovered, t + 110);
      const expectedAfter = orbitToState(orbit, t + 110);

      const isClampedNearCircular = orbit.e > 0 && orbit.e < 1e-5;
      const posDigits = isClampedNearCircular ? 6 : 9;
      if (orbit.e < 1e-5) {
        expect(recovered.e).toBe(0);
        expect(recovered.omega).toBe(0);
      } else {
        expect(recovered.e).toBeCloseTo(orbit.e, 9);
        expect(recovered.omega).toBeCloseTo(orbit.omega, 9);
      }
      expect(recovered.a).toBeCloseTo(orbit.a, 9);
      expect(stateAfter.pos.x).toBeCloseTo(expectedAfter.pos.x, posDigits);
      expect(stateAfter.pos.y).toBeCloseTo(expectedAfter.pos.y, posDigits);
      expect(stateAfter.vel.x).toBeCloseTo(expectedAfter.vel.x, posDigits);
      expect(stateAfter.vel.y).toBeCloseTo(expectedAfter.vel.y, posDigits);
    }
  });

  it('conserves orbital energy within < 1e-6 after 10 full orbital periods with no thrust', () => {
    const marsOrbit = CELESTIAL_BODIES_BY_ID.mars.orbit!;
    const period = getOrbitalPeriodSec(marsOrbit.a);
    let unit = makeTestUnit('chemical');
    unit = {
      ...unit,
      orbit: marsOrbit,
      ...orbitToState(marsOrbit, 0),
      deltaV: 0,
    };

    const initialEnergy = getSpecificOrbitalEnergy(unit.pos, unit.vel);
    const dt = 0.5;
    const totalTime = 10 * period;
    const steps = Math.floor(totalTime / dt);
    let t = 0;

    for (let i = 0; i < steps; i++) {
      const res = advanceUnitOrbit(unit, t, dt);
      unit = res.unit;
      t += dt;
    }

    const rem = totalTime - t;
    if (rem > 1e-9) {
      unit = advanceUnitOrbit(unit, t, rem).unit;
    }

    const finalEnergy = getSpecificOrbitalEnergy(unit.pos, unit.vel);
    const relError = Math.abs(finalEnergy - initialEnergy) / Math.abs(initialEnergy);
    expect(relError).toBeLessThan(1e-6);

    // Also verify repeated stateToOrbit -> orbitToState propagation stays well within < 1e-6
    let state = orbitToState(marsOrbit, 0);
    for (let i = 0; i < 400; i++) {
      const stepT = i * (totalTime / 400);
      const nextT = (i + 1) * (totalTime / 400);
      const orb = stateToOrbit(state.pos, state.vel, stepT);
      state = orbitToState(orb, nextT);
    }
    const chainedEnergy = getSpecificOrbitalEnergy(state.pos, state.vel);
    expect(Math.abs(chainedEnergy - initialEnergy) / Math.abs(initialEnergy)).toBeLessThan(1e-6);
  });

  it('handles chemical and nuclear impulsive burns and locks to inertial coasting when deltaV <= 0', () => {
    for (const propulsion of ['chemical', 'nuclear'] as const) {
      const unit = makeTestUnit(propulsion, 0.005);
      const dv = { x: 0, y: 0.003 };
      const withBurn: UnitEntity = {
        ...unit,
        plannedBurns: [{ executeAtSec: 0, deltaV: dv, durationSec: 0.1, isOccludedStart: false }],
      };

      const step = advanceUnitOrbit(withBurn, 0, 0.1);
      expect(step.activeBurn).toBe(true);
      expect(step.usedDeltaV).toBeCloseTo(0.003, 10);
      expect(step.unit.deltaV).toBeCloseTo(0.002, 10);
      expect(step.unit.orbit.a).toBeGreaterThan(1.0);
      expect(step.unit.plannedBurns).toHaveLength(0);

      // Exhaust remaining deltaV on a larger burn request
      const overBurn = applyImpulsiveBurn(
        { pos: step.unit.pos, vel: step.unit.vel },
        { x: 0, y: 0.01 },
        step.unit.deltaV,
        0.1,
      );
      expect(overBurn.usedDeltaV).toBeCloseTo(0.002, 10);
      expect(overBurn.remainingDeltaV).toBe(0);

      // Subsequent burns with deltaV <= 0 must produce zero velocity change (pure inertial coasting)
      const exhaustedUnit: UnitEntity = {
        ...step.unit,
        deltaV: 0,
        plannedBurns: [
          { executeAtSec: 0.1, deltaV: { x: 0, y: 0.005 }, durationSec: 0.1, isOccludedStart: false },
        ],
      };
      const inertialStep = advanceUnitOrbit(exhaustedUnit, 0.1, 0.1);
      const pureKepler = orbitToState(exhaustedUnit.orbit, 0.2);
      expect(inertialStep.activeBurn).toBe(false);
      expect(inertialStep.usedDeltaV).toBe(0);
      expect(inertialStep.unit.pos.x).toBeCloseTo(pureKepler.pos.x, 12);
      expect(inertialStep.unit.pos.y).toBeCloseTo(pureKepler.pos.y, 12);
    }
  });

  it('handles electric continuous micro-step thrust and propulsion subsystem health scaling', () => {
    expect(getPropulsionThrustFactor('normal')).toBe(1);
    expect(getPropulsionThrustFactor('damaged')).toBe(0.5);
    expect(getPropulsionThrustFactor('offline')).toBe(0);

    const baseOrbit: KeplerOrbit = { a: 1.0, e: 0, omega: 0, meanAnomaly0: 0, epochSec: 0 };
    const start = orbitToState(baseOrbit, 0);
    const maxElecAccel = PROPULSION_CONFIGS.electric.maxAccelAuPerSec2;

    const healthy = stepContinuousThrust(
      start,
      { x: 0, y: 0.01 },
      20,
      0.03,
      'electric',
      0,
      { subSteps: 10, propulsionHealth: 'normal' },
    );
    expect(healthy.usedDeltaV).toBeCloseTo(maxElecAccel * 20, 9);
    expect(healthy.orbit.a).toBeGreaterThan(1.0);
    expect(Math.abs(getSpecificOrbitalEnergy(healthy.state.pos, healthy.state.vel) + MU_SUN / (2 * healthy.orbit.a))).toBeLessThan(1e-10);

    const damaged = stepContinuousThrust(
      start,
      { x: 0, y: 0.01 },
      20,
      0.03,
      'electric',
      0,
      { subSteps: 10, propulsionHealth: 'damaged' },
    );
    expect(damaged.usedDeltaV).toBeCloseTo(healthy.usedDeltaV * 0.5, 9);

    const offlineUnit: UnitEntity = {
      ...makeTestUnit('electric', 0.03),
      subsystems: {
        propulsion: 'offline',
        sensors: 'normal',
        weapons: 'normal',
        thermal: 'normal',
      },
      plannedBurns: [
        { executeAtSec: 0, deltaV: { x: 0, y: 0.002 }, durationSec: 40, isOccludedStart: false },
      ],
    };
    const offlineStep = advanceUnitOrbit(offlineUnit, 0, 5);
    expect(offlineStep.activeBurn).toBe(false);
    expect(offlineStep.usedDeltaV).toBe(0);
    expect(offlineStep.unit.deltaV).toBe(0.03);
  });
});
