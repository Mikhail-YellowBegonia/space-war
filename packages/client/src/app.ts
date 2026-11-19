import {
  PROTOCOL_VERSION,
  SIM_TICK_RATE_HZ,
  UNIT_CONFIGS,
  orbitToState,
  type FactionId,
  type KeplerOrbit,
  type UnitEntity,
  type UnitKind,
} from '@space-war/shared';

/**
 * Formats the CIC boot banner displayed on the client shell.
 */
export function getClientBootBanner(): string {
  return `SPACE WAR CIC // PROTOCOL v${PROTOCOL_VERSION} // ${SIM_TICK_RATE_HZ}Hz`;
}

function makePreviewUnit(
  id: string,
  faction: FactionId,
  kind: UnitKind,
  orbit: KeplerOrbit,
  gameTimeSec: number,
  options: { radarActive?: boolean; emconSilent?: boolean } = {},
): UnitEntity {
  const cfg = UNIT_CONFIGS[kind];
  const state = orbitToState(orbit, gameTimeSec);
  return {
    id,
    faction,
    kind,
    propulsion: cfg.defaultPropulsion,
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
    deltaV: cfg.maxDeltaV,
    maxDeltaV: cfg.maxDeltaV,
    heat: 0,
    maxHeat: cfg.maxHeat,
    radiatorsOpen: !(options.emconSilent ?? false),
    emconSilent: options.emconSilent ?? false,
    radarActive: options.radarActive ?? false,
    jammerActive: false,
    ammoStock: cfg.weapons.ammoCapacity,
    plannedBurns: [],
  };
}

/**
 * Builds deterministic preview units on Earth, Mars, and Eros patrol orbits
 * for standalone SW-07 camera and vector-renderer verification prior to SW-08 MockWorldProvider.
 */
export function createPreviewUnits(gameTimeSec: number): UnitEntity[] {
  return [
    makePreviewUnit(
      'E-HOME',
      'earth',
      'home_base',
      { a: 1.0, e: 0.017, omega: 0, meanAnomaly0: 0, epochSec: 0 },
      gameTimeSec,
      { radarActive: true },
    ),
    makePreviewUnit(
      'E-RCN-1',
      'earth',
      'recon_corvette',
      { a: 1.18, e: 0.12, omega: 0.25, meanAnomaly0: 0.18, epochSec: 0 },
      gameTimeSec,
    ),
    makePreviewUnit(
      'E-TNK-1',
      'earth',
      'tanker',
      { a: 1.04, e: 0.03, omega: 0.05, meanAnomaly0: 6.2, epochSec: 0 },
      gameTimeSec,
    ),
    makePreviewUnit(
      'M-HOME',
      'mars',
      'home_base',
      { a: 1.52, e: 0.093, omega: 0.2, meanAnomaly0: 0.75, epochSec: 0 },
      gameTimeSec,
      { radarActive: true },
    ),
    makePreviewUnit(
      'M-RDR-1',
      'mars',
      'raider',
      { a: 1.36, e: 0.16, omega: 0.3, meanAnomaly0: 0.48, epochSec: 0 },
      gameTimeSec,
      { emconSilent: true },
    ),
    makePreviewUnit(
      'M-ESC-1',
      'mars',
      'escort_frigate',
      { a: 1.49, e: 0.08, omega: 0.22, meanAnomaly0: 0.69, epochSec: 0 },
      gameTimeSec,
      { radarActive: true },
    ),
  ];
}
