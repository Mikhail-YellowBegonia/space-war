import { describe, expect, it } from 'vitest';
import {
  ALL_UNIT_KINDS,
  BINGO_CONFIG,
  CORE_UNIT_KINDS,
  DRONE_UNIT_KINDS,
  LOGISTICS_CONFIG,
  MUNITION_CONFIGS,
  MUNITION_PROFILE_IDS,
  PROPULSION_CONFIGS,
  PROPULSION_TYPES,
  TIME_SCALE_CONFIG,
  UNIT_CONFIGS,
  WONDER_CONFIG,
  type ClientMessage,
  type FactionSnapshot,
  type PlayerCommand,
  type ServerMessage,
} from '../src/index.js';

describe('SW-02 domain contracts and static balance tables', () => {
  it('covers all 9 core GDD unit classes and 2 drone classes in UNIT_CONFIGS', () => {
    expect(CORE_UNIT_KINDS).toHaveLength(9);
    expect(DRONE_UNIT_KINDS).toHaveLength(2);
    expect(ALL_UNIT_KINDS).toHaveLength(11);

    for (const kind of ALL_UNIT_KINDS) {
      const cfg = UNIT_CONFIGS[kind];
      expect(cfg.kind).toBe(kind);
      expect(cfg.maxHp).toBeGreaterThan(0);
      expect(cfg.maxHeat).toBeGreaterThan(0);
      expect(cfg.maxDeltaV).toBeGreaterThanOrEqual(0);
      expect(cfg.allowedPropulsions).toContain(cfg.defaultPropulsion);
    }

    // Enforce geographic tiering constraints from GDD 6.1
    expect(UNIT_CONFIGS.home_base.logistics.canBuildShips).toBe(true);
    expect(UNIT_CONFIGS.mining_outpost.buildLocation).toBe('celestial_orbit');
    expect(UNIT_CONFIGS.mining_outpost.logistics.canBuildShips).toBe(false);
    expect(UNIT_CONFIGS.relay_depot.buildLocation).toBe('deep_space_orbit');
    expect(UNIT_CONFIGS.relay_depot.logistics.canBuildShips).toBe(false);
    expect(UNIT_CONFIGS.cruiser.buildLocation).toBe('home_base_only');
    expect(UNIT_CONFIGS.raider.buildLocation).toBe('home_base_only');
    expect(UNIT_CONFIGS.escort_frigate.buildLocation).toBe('home_base_only');
    expect(UNIT_CONFIGS.recon_corvette.buildLocation).toBe('home_base_only');
    expect(UNIT_CONFIGS.freighter.buildLocation).toBe('home_base_only');
    expect(UNIT_CONFIGS.tanker.buildLocation).toBe('home_base_only');
    expect(UNIT_CONFIGS.drone_recon.buildLocation).toBe('carrier_launched');
    expect(UNIT_CONFIGS.drone_ew.buildLocation).toBe('carrier_launched');
  });

  it('covers both unified munition profiles in MUNITION_CONFIGS', () => {
    expect(MUNITION_PROFILE_IDS).toEqual(['light_interceptor', 'heavy_torpedo']);

    for (const id of MUNITION_PROFILE_IDS) {
      const cfg = MUNITION_CONFIGS[id];
      expect(cfg.id).toBe(id);
      expect(cfg.hp).toBeGreaterThan(0);
      expect(cfg.maxDeltaV).toBeGreaterThan(0);
      expect(cfg.damage).toBeGreaterThan(0);
      expect(cfg.costOre).toBeGreaterThan(0);
    }

    expect(MUNITION_CONFIGS.heavy_torpedo.canColdCoast).toBe(true);
    expect(MUNITION_CONFIGS.heavy_torpedo.maxDeltaV).toBeGreaterThan(
      MUNITION_CONFIGS.light_interceptor.maxDeltaV,
    );
    expect(MUNITION_CONFIGS.light_interceptor.maxAccelAuPerSec2).toBeGreaterThan(
      MUNITION_CONFIGS.heavy_torpedo.maxAccelAuPerSec2,
    );
  });

  it('defines all three propulsion systems with physically consistent tradeoffs', () => {
    expect(PROPULSION_TYPES).toEqual(['chemical', 'nuclear', 'electric']);

    const chem = PROPULSION_CONFIGS.chemical;
    const nuc = PROPULSION_CONFIGS.nuclear;
    const elec = PROPULSION_CONFIGS.electric;

    expect(chem.burnMode).toBe('impulsive');
    expect(nuc.burnMode).toBe('impulsive');
    expect(elec.burnMode).toBe('continuous');

    expect(chem.maxAccelAuPerSec2).toBeGreaterThan(nuc.maxAccelAuPerSec2);
    expect(nuc.maxAccelAuPerSec2).toBeGreaterThan(elec.maxAccelAuPerSec2);

    expect(nuc.irFactor).toBeGreaterThan(chem.irFactor);
    expect(chem.irFactor).toBeGreaterThan(elec.irFactor);
  });

  it('defines 16-slot co-orbital wonder, time scale, Bingo, and logistics constants', () => {
    expect(WONDER_CONFIG.slotCount).toBe(16);
    expect(WONDER_CONFIG.namesByFaction.earth).toBe('Dyson Swarm Ring');
    expect(WONDER_CONFIG.namesByFaction.mars).toBe('Martian Orbital Accelerator');
    expect(WONDER_CONFIG.stabilizationHoldSec).toBe(60);
    expect(WONDER_CONFIG.orePerSlot).toBeGreaterThan(0);

    expect(TIME_SCALE_CONFIG.gameSecondsPerEarthYear).toBe(252);
    expect(BINGO_CONFIG.safetyMultiplier).toBe(1.15);
    expect(BINGO_CONFIG.amberThresholdMultiplier).toBe(1.2);
    expect(LOGISTICS_CONFIG.initialFreighterCap).toBeGreaterThan(0);
  });

  it('supports strongly typed command, snapshot, and WS protocol serialization', () => {
    const command: PlayerCommand = {
      type: 'fire_munition',
      unitId: 'ship-1',
      targetTrackId: 'trk-7',
      profileId: 'heavy_torpedo',
      count: 2,
      coldCoast: true,
    };

    const clientMsg: ClientMessage = {
      type: 'command',
      clientSeq: 42,
      command,
    };

    const snapshot: FactionSnapshot = {
      tick: 100,
      gameTimeSec: 10,
      faction: 'earth',
      resources: { ore: 300, propellant: 150 },
      freighterCap: 3,
      freightersInFlight: 1,
      celestials: [{ id: 'earth', pos: { x: 1, y: 0 }, vel: { x: 0, y: 0.0249 } }],
      ownUnits: [],
      ownMunitions: [],
      tracks: [
        {
          trackId: 'trk-7',
          confidence: 'bearing',
          suspectedKind: 'unknown',
          bearingRad: 1.25,
          originPos: { x: 1, y: 0 },
          lastObservedSec: 10,
          isJammed: false,
        },
      ],
      routes: [],
      ownWonder: [
        {
          index: 0,
          status: 'empty',
          progressOre: 0,
          requiredOre: WONDER_CONFIG.orePerSlot,
          hp: WONDER_CONFIG.slotMaxHp,
          maxHp: WONDER_CONFIG.slotMaxHp,
        },
      ],
      enemyWonderPublicProgress: 0,
      vfxEvents: [],
      winner: null,
    };

    const serverMsg: ServerMessage = {
      type: 'snapshot',
      snapshot,
    };

    const parsedClient = JSON.parse(JSON.stringify(clientMsg)) as ClientMessage;
    const parsedServer = JSON.parse(JSON.stringify(serverMsg)) as ServerMessage;

    expect(parsedClient).toEqual(clientMsg);
    expect(parsedServer).toEqual(serverMsg);
  });
});
