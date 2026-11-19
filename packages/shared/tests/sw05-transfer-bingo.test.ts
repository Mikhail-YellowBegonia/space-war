import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import {
  BINGO_CONFIG,
  CELESTIAL_BODIES_BY_ID,
  SOLAR_SYSTEM_BODIES,
  UNIT_CONFIGS,
  advanceUnitOrbit,
  calculateBingoDeltaV,
  classifyBingoWarning,
  evaluateBingo,
  getInterceptTransferOptions,
  getOrbitInsertionOptions,
  isOccluded,
  orbitToState,
  solveInterceptTransfer,
  solveLambertTransfer,
  solveOrbitInsertion,
  type KeplerOrbit,
  type PropulsionType,
  type UnitEntity,
} from '../src/index.js';

function makeShip(
  propulsion: PropulsionType,
  orbit: KeplerOrbit = CELESTIAL_BODIES_BY_ID.earth.orbit!,
  deltaV?: number,
): UnitEntity {
  const kind =
    propulsion === 'nuclear'
      ? 'cruiser'
      : propulsion === 'electric'
        ? 'recon_corvette'
        : 'raider';
  const cfg = UNIT_CONFIGS[kind];
  const state = orbitToState(orbit, 0);
  const dv = deltaV ?? cfg.maxDeltaV;
  return {
    id: `ship-${propulsion}`,
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

describe('SW-05 transfer solver and Bingo delta-v evaluation', () => {
  it('solves 2D prograde Lambert arcs accurately hitting destination at t0 + dt', () => {
    const dep = orbitToState(CELESTIAL_BODIES_BY_ID.earth.orbit!, 0).pos;
    const arr = orbitToState(CELESTIAL_BODIES_BY_ID.mars.orbit!, 178).pos;
    const sol = solveLambertTransfer(dep, arr, 178, 0);
    expect(sol).not.toBeNull();

    const arrived = orbitToState(sol!.orbit, 178);
    expect(arrived.pos.x).toBeCloseTo(arr.x, 4);
    expect(arrived.pos.y).toBeCloseTo(arr.y, 4);
    expect(arrived.vel.x).toBeCloseTo(sol!.v2.x, 4);
    expect(arrived.vel.y).toBeCloseTo(sol!.v2.y, 4);
  });

  it('computes Earth-to-Mars fuel transfer near 3.0 minutes, slower than fast but cheaper in delta-v', () => {
    const cruiser = makeShip('nuclear');
    const result = solveInterceptTransfer({ unit: cruiser, nowSec: 0 }, 'mars');

    expect(result.fuel.feasible).toBe(true);
    expect(result.fast.feasible).toBe(true);

    const fuelFlightSec = result.fuel.arrivalSec - result.fuel.burns[0]!.executeAtSec;
    expect(fuelFlightSec).toBeGreaterThan(150);
    expect(fuelFlightSec).toBeLessThan(210);
    expect(result.fuel.arrivalSec).toBeGreaterThan(result.fast.arrivalSec);
    expect(result.fuel.totalDeltaV).toBeLessThan(result.fast.totalDeltaV);
    expect(result.fuel.previewOrbitSegments.length).toBeGreaterThanOrEqual(2);

    // Executing the fuel transfer burns moves the ship onto Mars's trajectory
    let simulated: UnitEntity = { ...cruiser, plannedBurns: [...result.fuel.burns] };
    const totalTicks = Math.ceil(result.fuel.arrivalSec * 10) + 1;
    for (let tick = 0; tick < totalTicks; tick++) {
      simulated = advanceUnitOrbit(simulated, tick * 0.1, 0.1).unit;
    }
    const marsAtEnd = orbitToState(CELESTIAL_BODIES_BY_ID.mars.orbit!, totalTicks * 0.1);
    const sep = Math.hypot(simulated.pos.x - marsAtEnd.pos.x, simulated.pos.y - marsAtEnd.pos.y);
    expect(sep).toBeLessThan(0.02);
  });

  it('finds occluded departure windows for nuclear stealth transfers', () => {
    const cruiser = makeShip('nuclear');
    const res = solveInterceptTransfer({ unit: cruiser, nowSec: 0 }, 'mars');

    expect(res.stealth.feasible).toBe(true);
    expect(res.stealth.burns.length).toBeGreaterThanOrEqual(1);
    const depBurn = res.stealth.burns[0]!;
    expect(depBurn.isOccludedStart).toBe(true);
    expect(res.stealth.estimatedPeakIr).toBeLessThan(res.fast.estimatedPeakIr);

    const depPos = orbitToState(cruiser.orbit, depBurn.executeAtSec).pos;
    const marsPos = orbitToState(CELESTIAL_BODIES_BY_ID.mars.orbit!, depBurn.executeAtSec).pos;
    expect(isOccluded(depPos, marsPos, SOLAR_SYSTEM_BODIES, depBurn.executeAtSec)).toBe(true);
  });

  it('supports electric continuous spiral and chemical dual-mode stealth transfers', () => {
    const corvette = makeShip('electric');
    const elecOptions = getInterceptTransferOptions({ unit: corvette, nowSec: 0 }, 'eros');
    const elecStealth = elecOptions[2];
    expect(elecStealth.feasible).toBe(true);
    expect(elecStealth.burns.length).toBeGreaterThanOrEqual(1);
    expect(elecStealth.burns[0]!.durationSec).toBeGreaterThan(5);
    expect(elecStealth.estimatedPeakIr).toBeLessThan(0.15);
    expect(elecStealth.previewOrbitSegments.length).toBeGreaterThanOrEqual(2);

    // Chemical with occlusion available -> occluded pulse
    const raider = makeShip('chemical');
    const chemOccluded = solveInterceptTransfer({ unit: raider, nowSec: 0 }, 'eros');
    expect(chemOccluded.stealth.feasible).toBe(true);
    expect(chemOccluded.stealth.burns[0]!.isOccludedStart).toBe(true);

    // Chemical with zero occluder bodies -> throttled slow-burn fallback
    const chemFallback = solveInterceptTransfer(
      {
        unit: raider,
        nowSec: 0,
        celestialBodies: [],
        observerPositions: [{ x: 2.5, y: 0.5 }],
      },
      'eros',
    );
    expect(chemFallback.stealth.feasible).toBe(true);
    expect(chemFallback.stealth.burns[0]!.isOccludedStart).toBe(false);
    expect(chemFallback.stealth.burns[0]!.durationSec).toBeGreaterThanOrEqual(25);
    expect(chemFallback.stealth.estimatedPeakIr).toBeLessThan(chemFallback.fuel.estimatedPeakIr);
  });

  it('solves target orbit insertion mode across fuel, fast, and stealth profiles', () => {
    const raider = makeShip('chemical');
    const targetOrbit: KeplerOrbit = {
      a: 1.32,
      e: 0.16,
      omega: 0.4,
      meanAnomaly0: 0,
      epochSec: 0,
    };

    const options = getOrbitInsertionOptions({ unit: raider, nowSec: 0 }, targetOrbit);
    expect(options).toHaveLength(3);
    const [fuel, fast, stealth] = options;

    expect(fuel.feasible).toBe(true);
    expect(fast.feasible).toBe(true);
    expect(stealth.feasible).toBe(true);
    expect(fast.arrivalSec).toBeLessThanOrEqual(fuel.arrivalSec);
    expect(fuel.totalDeltaV).toBeLessThanOrEqual(fast.totalDeltaV + 1e-6);

    const map = solveOrbitInsertion({ unit: raider, nowSec: 0 }, targetOrbit);
    expect(map.fuel.mode).toBe('fuel');
    expect(map.fast.mode).toBe('fast');
    expect(map.stealth.mode).toBe('stealth');
  });

  it('computes conservative Bingo delta-v and classifies safe/amber/red warnings', () => {
    const erosOrbit = CELESTIAL_BODIES_BY_ID.eros.orbit!;
    const earthHome = CELESTIAL_BODIES_BY_ID.earth;

    const { bingoDeltaV, nearestResupplyId } = calculateBingoDeltaV(
      erosOrbit,
      [{ id: earthHome.id, orbit: earthHome.orbit! }],
      0,
    );
    expect(nearestResupplyId).toBe('earth');
    expect(bingoDeltaV).toBeGreaterThan(0);

    // Exact boundary behavior for 1.2x amber threshold
    expect(classifyBingoWarning(bingoDeltaV * 1.25, 0, bingoDeltaV)).toBe('safe');
    expect(
      classifyBingoWarning(bingoDeltaV * (BINGO_CONFIG.amberThresholdMultiplier - 0.05), 0, bingoDeltaV),
    ).toBe('amber');
    expect(classifyBingoWarning(bingoDeltaV * 0.9, 0, bingoDeltaV)).toBe('red');

    const evalRes = evaluateBingo(erosOrbit, 0.008, 0.004, [
      { id: earthHome.id, orbit: earthHome.orbit! },
    ]);
    expect(evalRes.bingoDeltaV).toBeCloseTo(bingoDeltaV, 12);
    expect(['safe', 'amber', 'red']).toContain(evalRes.warning);
  });

  it('completes single dual-mode transfer solves in under 15ms', () => {
    const cruiser = makeShip('nuclear');
    // Warm up JIT once
    solveInterceptTransfer({ unit: cruiser, nowSec: 0 }, 'mars');

    const tStart = performance.now();
    const intercept = solveInterceptTransfer({ unit: cruiser, nowSec: 12 }, 'mars');
    const interceptMs = performance.now() - tStart;

    const tInsertStart = performance.now();
    const insertion = solveOrbitInsertion(
      { unit: cruiser, nowSec: 12 },
      CELESTIAL_BODIES_BY_ID.eros.orbit!,
    );
    const insertMs = performance.now() - tInsertStart;

    expect(intercept.fuel.feasible).toBe(true);
    expect(insertion.fuel.feasible).toBe(true);
    expect(interceptMs).toBeLessThan(15);
    expect(insertMs).toBeLessThan(15);
  });
});
