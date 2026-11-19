import { PROPULSION_CONFIGS, UNIT_CONFIGS } from '@space-war/shared';
import { describe, expect, it } from 'vitest';
import {
  HeadlessMatchRunner,
  computeUnitIrSignature,
  createUnitEntity,
  getThermalSubsystemFactor,
  stepUnitThermal,
} from '../src/index.js';

describe('SW-10 spacecraft thermal sink, radiators, and EMCON model', () => {
  it('accumulates heat in EMCON silent coasting until maxHeat and triggers forced radiator venting', () => {
    let raider = createUnitEntity({
      id: 'raider-silent',
      faction: 'earth',
      kind: 'raider',
      orbit: { a: 1.0, e: 0, omega: 0, meanAnomaly0: 0, epochSec: 0 },
      emconSilent: true,
    });
    raider = {
      ...raider,
      heat: raider.maxHeat - 0.5,
      ladarTargetAngle: 0.5,
    };

    const silentIr = computeUnitIrSignature(raider);
    const step1 = stepUnitThermal(raider, 0.1);
    expect(step1.unit.heat).toBeGreaterThan(raider.heat);
    expect(step1.unit.heat).toBeLessThan(raider.maxHeat);
    expect(step1.forcedVenting).toBe(false);
    expect(step1.unit.emconSilent).toBe(true);

    // Push past maxHeat to force emergency radiator deployment
    const step2 = stepUnitThermal(step1.unit, 1.0);
    expect(step2.unit.heat).toBe(raider.maxHeat);
    expect(step2.forcedVenting).toBe(true);
    expect(step2.unit.emconSilent).toBe(false);
    expect(step2.unit.radiatorsOpen).toBe(true);
    expect(step2.irSignature).toBeGreaterThan(silentIr * 5);
  });

  it('triggers thermal overheat degradation when thermal subsystem is offline', () => {
    let cruiser = createUnitEntity({
      id: 'cruiser-overheat',
      faction: 'mars',
      kind: 'cruiser',
      orbit: { a: 1.52, e: 0, omega: 0, meanAnomaly0: 0, epochSec: 0 },
      emconSilent: true,
    });
    cruiser = {
      ...cruiser,
      heat: cruiser.maxHeat - 0.1,
      radarActive: true,
      jammerActive: true,
      ladarTargetAngle: 1.2,
      subsystems: {
        ...cruiser.subsystems,
        thermal: 'offline',
      },
    };

    const res = stepUnitThermal(cruiser, 1.0);
    expect(res.unit.heat).toBe(cruiser.maxHeat);
    expect(res.overheatedDegraded).toBe(true);
    expect(res.unit.radarActive).toBe(false);
    expect(res.unit.jammerActive).toBe(false);
    expect(res.unit.ladarTargetAngle).toBeUndefined();
    expect(res.unit.subsystems.weapons).toBe('damaged');
    expect(res.unit.subsystems.sensors).toBe('damaged');
  });

  it('produces massive IR spike on nuclear burn and follows expected radiator cooling curve', () => {
    const cruiser = createUnitEntity({
      id: 'cruiser-nuc',
      faction: 'earth',
      kind: 'cruiser',
      orbit: { a: 1.0, e: 0, omega: 0, meanAnomaly0: 0, epochSec: 0 },
      emconSilent: false,
    });
    const cfg = UNIT_CONFIGS.cruiser;
    const propCfg = PROPULSION_CONFIGS.nuclear;

    const idleIr = computeUnitIrSignature(cruiser);
    const burnDeltaV = 0.002;
    const burnStep = stepUnitThermal(cruiser, 0.1, { usedDeltaV: burnDeltaV });

    const expectedBurnHeat =
      cfg.baseHeatGenPerSec * 0.1 +
      burnDeltaV * propCfg.heatPerDeltaV -
      cfg.radiatorCoolingPerSec * 0.1;
    expect(burnStep.unit.heat).toBeCloseTo(expectedBurnHeat, 8);
    expect(burnStep.irSignature).toBeGreaterThan(idleIr * 20);

    // Subsequent 10 seconds with radiators open cools linearly at (radiatorCooling - baseHeatGen) / s
    let coolingUnit = burnStep.unit;
    for (let i = 0; i < 100; i++) {
      coolingUnit = stepUnitThermal(coolingUnit, 0.1).unit;
    }
    const expectedNetCoolPerSec = cfg.radiatorCoolingPerSec - cfg.baseHeatGenPerSec;
    expect(coolingUnit.heat).toBeCloseTo(
      Math.max(0, burnStep.unit.heat - expectedNetCoolPerSec * 10),
      6,
    );

    // Damaged thermal subsystem cools at 40% rate
    expect(getThermalSubsystemFactor('normal')).toBe(1.0);
    expect(getThermalSubsystemFactor('damaged')).toBe(0.4);
    expect(getThermalSubsystemFactor('offline')).toBe(0.1);

    const damagedCruiser = {
      ...burnStep.unit,
      subsystems: { ...burnStep.unit.subsystems, thermal: 'damaged' as const },
    };
    const damagedAfter = stepUnitThermal(damagedCruiser, 1.0);
    const healthyAfter = stepUnitThermal(burnStep.unit, 1.0);
    expect(damagedAfter.unit.heat).toBeGreaterThan(healthyAfter.unit.heat);
  });

  it('tracks live heat and IR spikes inside SimulationLoop ticks', () => {
    const runner = new HeadlessMatchRunner();
    const cmd = runner.submitCommand('earth', {
      type: 'plan_orbit_insertion',
      unitId: 'earth-cruiser-1',
      targetOrbit: { a: 1.32, e: 0.1, omega: 0.2, meanAnomaly0: 0, epochSec: 0 },
      mode: 'fast',
    });
    expect(cmd.accepted).toBe(true);

    runner.stepTick();
    const snap = runner.getSnapshot('earth');
    const cruiser = snap.ownUnits.find((u) => u.id === 'earth-cruiser-1')!;
    expect(cruiser.heat).toBeGreaterThan(0);
    expect(runner.loop.getUnitIrSignature('earth-cruiser-1')).toBeGreaterThan(100);
  });
});
