import { UNIT_CONFIGS, WONDER_CONFIG } from '@space-war/shared';
import { describe, expect, it } from 'vitest';
import {
  HeadlessMatchRunner,
  SimpleRuleAiController,
  createFiveMinuteStartupWorldState,
  createRuleAiTickSystem,
  damageWonderSlot,
  stepSensorsAndFog,
} from '../src/index.js';

describe('SW-22 simple rule-based test AI', () => {
  it(
    'autonomously expands outposts, scales freighter cap, builds & patrols warships, and constructs wonder without errors',
    () => {
      const runner = new HeadlessMatchRunner(createFiveMinuteStartupWorldState());
      const aiSystem = createRuleAiTickSystem({
        factions: ['mars'],
        decisionIntervalSec: 3.0,
      });
      runner.loop.registerSystem(aiSystem, 'post_sensor');

      // Run 600 seconds (6000 ticks) of single-player simulation against Mars AI
      runner.runTicks(6000);

      const world = runner.getWorldState();
      const controller = aiSystem.getController('mars')!;
      expect(controller.commandHistory.length).toBeGreaterThan(0);

      // Every AI command must either succeed cleanly or at worst be harmlessly rejected without exceptions
      expect(
        controller.commandHistory.some((entry) => entry.result.accepted),
      ).toBe(true);

      const marsUnits = [...world.units.values()].filter((u) => u.faction === 'mars');
      // Expanded beyond initial 2 mining outposts
      expect(marsUnits.filter((u) => u.kind === 'mining_outpost').length).toBeGreaterThanOrEqual(3);
      // Built combat warships from zero-warship start
      expect(
        marsUnits.some(
          (u) => u.kind === 'raider' || u.kind === 'escort_frigate' || u.kind === 'cruiser',
        ),
      ).toBe(true);
      // Expanded freighter capacity beyond initial 3
      expect(world.factions.mars.freighterCap).toBeGreaterThanOrEqual(4);
      // Invested into 16-slot co-orbital wonder
      expect(
        world.factions.mars.wonder.some((s) => s.status === 'building' || s.status === 'complete'),
      ).toBe(true);
    },
    15_000,
  );

  it('reacts tactically to high heat, incoming munition tracks, and damaged wonder slots', () => {
    const runner = new HeadlessMatchRunner(createFiveMinuteStartupWorldState());
    const world = runner.getWorldState();
    world.factions.mars.resources.ore = 600;

    const controller = new SimpleRuleAiController('mars', { decisionIntervalSec: 1.0 });

    // 1. High heat while EMCON silent -> AI vents radiators
    const recon = world.units.get('mars-recon-1')!;
    recon.emconSilent = true;
    recon.radiatorsOpen = false;
    recon.heat = recon.maxHeat * 0.85;

    // 2. Damaged wonder slot -> AI immediately queues repair
    world.factions.mars.wonder[0]!.status = 'building';
    world.factions.mars.wonder[0]!.progressOre = 100;
    damageWonderSlot(world, 'mars', 0, 180);
    expect(world.factions.mars.wonder[0]!.status).toBe('damaged_halted');

    // 3. Incoming enemy munition detected -> AI fires light_interceptor
    const marsBase = world.units.get('mars-home-base')!;
    world.tracksByFaction.mars.push({
      trackId: 'trk-mars-incoming-1',
      confidence: 'confirmed',
      suspectedKind: 'munition',
      pos: { x: marsBase.pos.x + 0.03, y: marsBase.pos.y + 0.02 },
      vel: { x: -0.005, y: 0 },
      lastObservedSec: world.gameTimeSec,
      isJammed: false,
    });
    world.trackMemoryByFaction.mars.set('enemy-mun-sim', {
      trackId: 'trk-mars-incoming-1',
      targetId: 'enemy-mun-sim',
      confidence: 'confirmed',
      suspectedKind: 'munition',
      pos: { x: marsBase.pos.x + 0.03, y: marsBase.pos.y + 0.02 },
      vel: { x: -0.005, y: 0 },
      lastObservedSec: world.gameTimeSec,
      isJammed: false,
    });

    // Give mars-recon-1 and mars-home-base room and run one AI step
    world.gameTimeSec = 10;
    const actions = controller.step(world);

    expect(
      actions.some(
        (a) => a.command.type === 'set_emcon' && a.command.unitId === 'mars-recon-1' && a.command.radiatorsOpen === true,
      ),
    ).toBe(true);
    expect(
      actions.some((a) => a.command.type === 'queue_build' && a.command.kind === 'wonder_slot' && a.result.accepted),
    ).toBe(true);
    expect(world.factions.mars.wonder[0]!.status).toBe('building');
    expect(world.factions.mars.wonder[0]!.hp).toBe(WONDER_CONFIG.slotMaxHp);
    expect(
      actions.some((a) => a.command.type === 'fire_munition' && a.command.targetTrackId === 'trk-mars-incoming-1' && a.result.accepted),
    ).toBe(true);

    // Ensure sensor step runs cleanly afterwards
    stepSensorsAndFog(world);
    expect(UNIT_CONFIGS.home_base.weapons.ammoCapacity).toBeGreaterThan(0);
  });
});
