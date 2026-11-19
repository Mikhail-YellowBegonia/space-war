import { MUNITION_CONFIGS, orbitToState, type MunitionEntity } from '@space-war/shared';
import { describe, expect, it } from 'vitest';
import {
  COMBAT_CONSTANTS,
  HeadlessMatchRunner,
  canUnitFireLaser,
  computeCiwsInterceptProbability,
  createUnitEntity,
  evaluateCiwsIntercept,
  isUnitThermallyLockedOut,
  stepCombatSystem,
  type WorldState,
} from '../src/index.js';

function createCleanRunner(): HeadlessMatchRunner {
  const runner = new HeadlessMatchRunner();
  const world: WorldState = runner.getWorldState();
  world.units.clear();
  world.munitions.clear();
  world.munitionMeta.clear();
  world.laserAblationByUnit.clear();
  world.laserActiveUnitIds.clear();
  world.tracksByFaction.earth = [];
  world.tracksByFaction.mars = [];
  world.trackMemoryByFaction.earth.clear();
  world.trackMemoryByFaction.mars.clear();
  return runner;
}

describe('SW-16 short-range laser, numerical CIWS/gun combat, and subsystem degradation', () => {
  it('intercepts incoming munitions via short-range laser point defense and adds laser heat', () => {
    const runner = createCleanRunner();
    const world = runner.getWorldState();

    const frigate = createUnitEntity({
      id: 'e-frigate',
      faction: 'earth',
      kind: 'escort_frigate',
      orbit: { a: 1.0, e: 0, omega: 0, meanAnomaly0: Math.PI / 2, epochSec: 0 },
      emconSilent: false,
    });
    const munOrbit = { a: 1.012, e: 0, omega: 0, meanAnomaly0: Math.PI / 2, epochSec: 0 };
    const munState = orbitToState(munOrbit, 0);
    const incoming: MunitionEntity = {
      id: 'm-mun-1',
      faction: 'mars',
      profileId: 'light_interceptor',
      pos: munState.pos,
      vel: munState.vel,
      orbit: munOrbit,
      deltaV: MUNITION_CONFIGS.light_interceptor.maxDeltaV,
      targetId: frigate.id,
      seekerMode: 'ir',
      coldCoast: false,
    };

    world.units.set(frigate.id, frigate);
    world.munitions.set(incoming.id, incoming);

    let intercepted = false;
    let sawLaserVfx = false;
    for (let i = 0; i < 20; i++) {
      runner.stepTick();
      if (world.vfxEvents.some((ev) => ev.kind === 'laser')) {
        sawLaserVfx = true;
      }
      const m = world.munitions.get(incoming.id);
      if (!m || m.intercepted) {
        intercepted = true;
        break;
      }
    }

    expect(sawLaserVfx).toBe(true);
    expect(intercepted).toBe(true);
    expect(world.units.get(frigate.id)!.heat).toBeGreaterThan(0);
  });

  it('ablates enemy thermal subsystem with laser fire, disabling enemy laser and sustained thrust', () => {
    const runner = createCleanRunner();
    const world = runner.getWorldState();

    const earthFrigate = createUnitEntity({
      id: 'e-frigate',
      faction: 'earth',
      kind: 'escort_frigate',
      orbit: { a: 1.0, e: 0, omega: 0, meanAnomaly0: Math.PI / 2, epochSec: 0 },
      emconSilent: false,
    });
    const marsCruiser = createUnitEntity({
      id: 'm-cruiser',
      faction: 'mars',
      kind: 'cruiser',
      orbit: { a: 1.01, e: 0, omega: 0, meanAnomaly0: Math.PI / 2, epochSec: 0 },
      emconSilent: false,
    });
    // Pre-warm enemy cruiser near saturation and schedule a sustained burn
    marsCruiser.heat = marsCruiser.maxHeat * 0.94;
    marsCruiser.plannedBurns = [
      {
        executeAtSec: 0,
        deltaV: { x: 0, y: 0.002 },
        durationSec: 10,
        isOccludedStart: false,
      },
    ];

    world.units.set(earthFrigate.id, earthFrigate);
    world.units.set(marsCruiser.id, marsCruiser);

    // Run ticks while frigate laser ablates cruiser's thermal subsystem
    for (let i = 0; i < 25; i++) {
      runner.stepTick();
      const enemy = world.units.get(marsCruiser.id)!;
      if (enemy.subsystems.thermal === 'offline') {
        break;
      }
    }

    const ablatedCruiser = world.units.get(marsCruiser.id)!;
    expect(ablatedCruiser.subsystems.thermal).not.toBe('normal');

    // Push thermal to offline/saturated and verify laser + sustained burn lockout
    ablatedCruiser.subsystems.thermal = 'offline';
    ablatedCruiser.heat = ablatedCruiser.maxHeat * 0.96;
    world.units.set(ablatedCruiser.id, ablatedCruiser);

    expect(canUnitFireLaser(ablatedCruiser)).toBe(false);
    expect(isUnitThermallyLockedOut(ablatedCruiser)).toBe(true);

    const dvBeforeLockedTick = ablatedCruiser.deltaV;
    runner.stepTick();
    const afterLockedTick = world.units.get(marsCruiser.id)!;
    expect(afterLockedTick.deltaV).toBe(dvBeforeLockedTick);
  });

  it('greatly improves convoy CIWS survival rate against saturation salvos when an escort frigate is present', () => {
    const runSalvoTrial = (withEscort: boolean): { pSingle: number; interceptedCount: number; freighterHp: number } => {
      const runner = createCleanRunner();
      const world = runner.getWorldState();

      const freighter = createUnitEntity({
        id: 'e-freighter',
        faction: 'earth',
        kind: 'freighter',
        orbit: { a: 1.0, e: 0, omega: 0, meanAnomaly0: Math.PI / 2, epochSec: 0 },
      });
      world.units.set(freighter.id, freighter);

      if (withEscort) {
        const escort = createUnitEntity({
          id: 'e-escort',
          faction: 'earth',
          kind: 'escort_frigate',
          orbit: { a: 1.01, e: 0, omega: 0, meanAnomaly0: Math.PI / 2, epochSec: 0 },
        });
        world.units.set(escort.id, escort);
      }

      const salvoSize = 10;
      for (let i = 0; i < salvoSize; i++) {
        const munOrbit = { a: 1.005, e: 0, omega: 0, meanAnomaly0: Math.PI / 2, epochSec: 0 };
        const st = orbitToState(munOrbit, 0);
        world.munitions.set(`m-salvo-${i}`, {
          id: `m-salvo-${i}`,
          faction: 'mars',
          profileId: 'heavy_torpedo',
          pos: st.pos,
          vel: st.vel,
          orbit: munOrbit,
          deltaV: 0.01,
          targetId: freighter.id,
          seekerMode: 'radar',
          coldCoast: false,
        });
      }

      const sampleMun = world.munitions.get('m-salvo-0')!;
      const pSingle = computeCiwsInterceptProbability(world, sampleMun, freighter);

      let interceptedCount = 0;
      for (let i = 0; i < salvoSize; i++) {
        const mun = world.munitions.get(`m-salvo-${i}`)!;
        if (evaluateCiwsIntercept(world, mun, world.units.get(freighter.id)!)) {
          interceptedCount += 1;
        } else {
          const cur = world.units.get(freighter.id)!;
          world.units.set(freighter.id, {
            ...cur,
            hp: Math.max(0, cur.hp - MUNITION_CONFIGS.heavy_torpedo.damage),
          });
        }
      }

      return {
        pSingle,
        interceptedCount,
        freighterHp: world.units.get(freighter.id)!.hp,
      };
    };

    const unescorted = runSalvoTrial(false);
    const escorted = runSalvoTrial(true);

    expect(escorted.pSingle).toBeGreaterThan(unescorted.pSingle + 0.25);
    expect(escorted.interceptedCount).toBeGreaterThan(unescorted.interceptedCount);
  });

  it('settles close-range numerical gun DPS, scales with weapons subsystem health, and triggers home base defeat', () => {
    const runner = createCleanRunner();
    const world = runner.getWorldState();

    const earthCruiser = createUnitEntity({
      id: 'e-cruiser',
      faction: 'earth',
      kind: 'cruiser',
      orbit: { a: 1.0, e: 0, omega: 0, meanAnomaly0: Math.PI / 2, epochSec: 0 },
      emconSilent: true,
    });
    const marsHome = createUnitEntity({
      id: 'mars-home-base',
      faction: 'mars',
      kind: 'home_base',
      orbit: {
        a: 1.0 + COMBAT_CONSTANTS.closeGunRangeAu * 0.5,
        e: 0,
        omega: 0,
        meanAnomaly0: Math.PI / 2,
        epochSec: 0,
      },
      emconSilent: true,
    });
    marsHome.hp = 4;

    world.units.set(earthCruiser.id, earthCruiser);
    world.units.set(marsHome.id, marsHome);

    // Damaged weapons halves gun DPS
    const healthyDmgCheck = marsHome.hp;
    stepCombatSystem(world, 0.1); // 24 * 0.1 = 2.4 dmg
    const afterHealthy = world.units.get(marsHome.id)!.hp;
    expect(afterHealthy).toBeCloseTo(healthyDmgCheck - 2.4, 6);

    // Degrade cruiser weapons -> damaged (12 * 0.1 = 1.2 dmg)
    world.units.set(earthCruiser.id, {
      ...earthCruiser,
      subsystems: { ...earthCruiser.subsystems, weapons: 'damaged' },
    });
    stepCombatSystem(world, 0.1);
    const afterDamaged = world.units.get(marsHome.id)!.hp;
    expect(afterDamaged).toBeCloseTo(afterHealthy - 1.2, 6);

    // Final tick finishes Mars home_base -> Earth wins
    stepCombatSystem(world, 0.1);
    expect(world.units.get(marsHome.id)!.hp).toBe(0);
    expect(world.winner).toBe('earth');
  });
});
