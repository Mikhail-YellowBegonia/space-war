import type {
  FactionId,
  MunitionProfileId,
  MunitionSeekerMode,
  PropulsionType,
  UnitKind,
} from '../types/index.js';

export const TIME_SCALE_CONFIG = {
  /** Compressed duration of 1 Earth orbital period at 1.0 AU (4.2 minutes). */
  gameSecondsPerEarthYear: 252,
  auInKm: 149_597_870.7,
  /** Conversion factor from internal AU/game-sec velocity to display km/s. */
  auPerSecToKmPerSec: 149_597_870.7 / ((365.25 * 86400) / 252),
} as const;

export const BINGO_CONFIG = {
  /** Conservative safety margin applied when computing Bingo return delta-v. */
  safetyMultiplier: 1.15,
  /** Amber warning threshold multiplier relative to Bingo delta-v. */
  amberThresholdMultiplier: 1.2,
} as const;

export type BurnMode = 'impulsive' | 'continuous';
export type StealthBurnStrategy = 'occluded_pulse' | 'throttled_burn' | 'continuous_low_thrust';

export interface PropulsionConfig {
  id: PropulsionType;
  name: string;
  burnMode: BurnMode;
  /** Maximum thrust acceleration in AU/s^2. */
  maxAccelAuPerSec2: number;
  /** Infrared signature multiplier while actively thrusting. */
  irFactor: number;
  /** Heat sink load generated per AU/s of delta-v expended. */
  heatPerDeltaV: number;
  stealthStrategies: readonly StealthBurnStrategy[];
}

export const PROPULSION_TYPES: readonly PropulsionType[] = ['chemical', 'nuclear', 'electric'];

export const PROPULSION_CONFIGS: Readonly<Record<PropulsionType, PropulsionConfig>> = {
  chemical: {
    id: 'chemical',
    name: 'Chemical Bipropellant',
    burnMode: 'impulsive',
    maxAccelAuPerSec2: 0.0025,
    irFactor: 14,
    heatPerDeltaV: 2200,
    stealthStrategies: ['occluded_pulse', 'throttled_burn'],
  },
  nuclear: {
    id: 'nuclear',
    name: 'Nuclear Thermal',
    burnMode: 'impulsive',
    maxAccelAuPerSec2: 0.0018,
    irFactor: 100,
    heatPerDeltaV: 4800,
    stealthStrategies: ['occluded_pulse'],
  },
  electric: {
    id: 'electric',
    name: 'Ion / Hall Electric',
    burnMode: 'continuous',
    maxAccelAuPerSec2: 0.000045,
    irFactor: 0.4,
    heatPerDeltaV: 450,
    stealthStrategies: ['continuous_low_thrust'],
  },
};

export interface MunitionConfig {
  id: MunitionProfileId;
  name: string;
  costOre: number;
  buildTimeSec: number;
  hp: number;
  /** Total delta-v budget in AU/s. */
  maxDeltaV: number;
  /** Maximum burn acceleration in AU/s^2. */
  maxAccelAuPerSec2: number;
  defaultSeekerMode: MunitionSeekerMode;
  seekerRangeAu: number;
  canColdCoast: boolean;
  rcs: number;
  baseIr: number;
  damage: number;
  /** Point-defense / intercept proximity radius in AU. */
  interceptRadiusAu: number;
  /** Penalty applied to defender CIWS hit probability due to speed/agility. */
  ciwsEvasionPenalty: number;
}

export const MUNITION_PROFILE_IDS: readonly MunitionProfileId[] = [
  'light_interceptor',
  'heavy_torpedo',
];

export const MUNITION_CONFIGS: Readonly<Record<MunitionProfileId, MunitionConfig>> = {
  light_interceptor: {
    id: 'light_interceptor',
    name: 'Light Interceptor Missile',
    costOre: 12,
    buildTimeSec: 12,
    hp: 20,
    maxDeltaV: 0.0085,
    maxAccelAuPerSec2: 0.006,
    defaultSeekerMode: 'ir',
    seekerRangeAu: 0.08,
    canColdCoast: false,
    rcs: 0.25,
    baseIr: 4.5,
    damage: 45,
    interceptRadiusAu: 0.004,
    ciwsEvasionPenalty: 0.18,
  },
  heavy_torpedo: {
    id: 'heavy_torpedo',
    name: 'Heavy Cold-Coast Torpedo',
    costOre: 36,
    buildTimeSec: 28,
    hp: 65,
    maxDeltaV: 0.015,
    maxAccelAuPerSec2: 0.003,
    defaultSeekerMode: 'inertial_then_active',
    seekerRangeAu: 0.14,
    canColdCoast: true,
    rcs: 0.55,
    baseIr: 2.0,
    damage: 140,
    interceptRadiusAu: 0.006,
    ciwsEvasionPenalty: 0.06,
  },
};

export type UnitCategory = 'station' | 'civilian' | 'combat' | 'drone';

export type UnitBuildLocation =
  | 'initial_only'
  | 'celestial_orbit'
  | 'deep_space_orbit'
  | 'home_base_only'
  | 'carrier_launched';

export interface UnitSensorConfig {
  passiveIrSensitivity: number;
  passiveOpticalSensitivity: number;
  radarPower: number;
  radarRangeAu: number;
  esmSensitivity: number;
  ladarRangeAu: number;
  ladarConeRad: number;
  ladarHeatPerSec: number;
}

export interface UnitWeaponConfig {
  ammoCapacity: number;
  laserDps: number;
  laserRangeAu: number;
  laserHeatPerSec: number;
  ciwsRating: number;
  gunDps: number;
  droneCapacity: number;
}

export interface UnitLogisticsConfig {
  cargoCapacity: number;
  miningRatePerSec: number;
  canResupply: boolean;
  canBuildShips: boolean;
}

export interface UnitConfig {
  kind: UnitKind;
  name: string;
  category: UnitCategory;
  defaultPropulsion: PropulsionType;
  allowedPropulsions: readonly PropulsionType[];
  buildLocation: UnitBuildLocation;
  costOre: number;
  costPropellant: number;
  buildTimeSec: number;
  maxHp: number;
  /** Delta-v capacity in AU/s. */
  maxDeltaV: number;
  maxHeat: number;
  baseHeatGenPerSec: number;
  radiatorCoolingPerSec: number;
  passiveRadiatorIr: number;
  rcs: number;
  opticalCrossSection: number;
  albedo: number;
  sensors: UnitSensorConfig;
  weapons: UnitWeaponConfig;
  logistics: UnitLogisticsConfig;
}

export const CORE_UNIT_KINDS: readonly UnitKind[] = [
  'home_base',
  'mining_outpost',
  'relay_depot',
  'freighter',
  'recon_corvette',
  'escort_frigate',
  'raider',
  'cruiser',
  'tanker',
];

export const DRONE_UNIT_KINDS: readonly UnitKind[] = ['drone_recon', 'drone_ew'];

export const ALL_UNIT_KINDS: readonly UnitKind[] = [...CORE_UNIT_KINDS, ...DRONE_UNIT_KINDS];

export const UNIT_CONFIGS: Readonly<Record<UnitKind, UnitConfig>> = {
  home_base: {
    kind: 'home_base',
    name: 'Home Base Orbital Complex',
    category: 'station',
    defaultPropulsion: 'chemical',
    allowedPropulsions: ['chemical'],
    buildLocation: 'initial_only',
    costOre: 0,
    costPropellant: 0,
    buildTimeSec: 0,
    maxHp: 2400,
    maxDeltaV: 0,
    maxHeat: 500,
    baseHeatGenPerSec: 1.2,
    radiatorCoolingPerSec: 6.0,
    passiveRadiatorIr: 18,
    rcs: 12,
    opticalCrossSection: 10,
    albedo: 0.45,
    sensors: {
      passiveIrSensitivity: 1.5,
      passiveOpticalSensitivity: 1.5,
      radarPower: 2.0,
      radarRangeAu: 0.35,
      esmSensitivity: 1.8,
      ladarRangeAu: 0.04,
      ladarConeRad: 0.35,
      ladarHeatPerSec: 3.5,
    },
    weapons: {
      ammoCapacity: 32,
      laserDps: 28,
      laserRangeAu: 0.03,
      laserHeatPerSec: 4.5,
      ciwsRating: 0.65,
      gunDps: 18,
      droneCapacity: 6,
    },
    logistics: {
      cargoCapacity: 0,
      miningRatePerSec: 0,
      canResupply: true,
      canBuildShips: true,
    },
  },
  mining_outpost: {
    kind: 'mining_outpost',
    name: 'Celestial Mining Outpost',
    category: 'station',
    defaultPropulsion: 'chemical',
    allowedPropulsions: ['chemical'],
    buildLocation: 'celestial_orbit',
    costOre: 140,
    costPropellant: 20,
    buildTimeSec: 45,
    maxHp: 550,
    maxDeltaV: 0.002,
    maxHeat: 180,
    baseHeatGenPerSec: 0.6,
    radiatorCoolingPerSec: 2.5,
    passiveRadiatorIr: 7,
    rcs: 4.5,
    opticalCrossSection: 4.0,
    albedo: 0.35,
    sensors: {
      passiveIrSensitivity: 0.9,
      passiveOpticalSensitivity: 0.9,
      radarPower: 0.6,
      radarRangeAu: 0.14,
      esmSensitivity: 1.0,
      ladarRangeAu: 0,
      ladarConeRad: 0,
      ladarHeatPerSec: 0,
    },
    weapons: {
      ammoCapacity: 4,
      laserDps: 0,
      laserRangeAu: 0,
      laserHeatPerSec: 0,
      ciwsRating: 0.25,
      gunDps: 4,
      droneCapacity: 0,
    },
    logistics: {
      cargoCapacity: 300,
      miningRatePerSec: 2.0,
      canResupply: true,
      canBuildShips: false,
    },
  },
  relay_depot: {
    kind: 'relay_depot',
    name: 'Orbital Logistics Relay Depot',
    category: 'station',
    defaultPropulsion: 'electric',
    allowedPropulsions: ['electric', 'chemical'],
    buildLocation: 'deep_space_orbit',
    costOre: 160,
    costPropellant: 40,
    buildTimeSec: 50,
    maxHp: 650,
    maxDeltaV: 0.005,
    maxHeat: 200,
    baseHeatGenPerSec: 0.5,
    radiatorCoolingPerSec: 2.8,
    passiveRadiatorIr: 6,
    rcs: 5.0,
    opticalCrossSection: 4.5,
    albedo: 0.3,
    sensors: {
      passiveIrSensitivity: 1.3,
      passiveOpticalSensitivity: 1.2,
      radarPower: 1.1,
      radarRangeAu: 0.22,
      esmSensitivity: 1.6,
      ladarRangeAu: 0.025,
      ladarConeRad: 0.25,
      ladarHeatPerSec: 2.5,
    },
    weapons: {
      ammoCapacity: 8,
      laserDps: 10,
      laserRangeAu: 0.02,
      laserHeatPerSec: 2.8,
      ciwsRating: 0.35,
      gunDps: 6,
      droneCapacity: 2,
    },
    logistics: {
      cargoCapacity: 400,
      miningRatePerSec: 0,
      canResupply: true,
      canBuildShips: false,
    },
  },
  freighter: {
    kind: 'freighter',
    name: 'Pooled Cargo Freighter',
    category: 'civilian',
    defaultPropulsion: 'chemical',
    allowedPropulsions: ['chemical', 'electric'],
    buildLocation: 'home_base_only',
    costOre: 80,
    costPropellant: 20,
    buildTimeSec: 25,
    maxHp: 140,
    maxDeltaV: 0.014,
    maxHeat: 80,
    baseHeatGenPerSec: 0.2,
    radiatorCoolingPerSec: 1.2,
    passiveRadiatorIr: 3.5,
    rcs: 3.2,
    opticalCrossSection: 3.0,
    albedo: 0.4,
    sensors: {
      passiveIrSensitivity: 0.5,
      passiveOpticalSensitivity: 0.5,
      radarPower: 0.2,
      radarRangeAu: 0.06,
      esmSensitivity: 0.6,
      ladarRangeAu: 0,
      ladarConeRad: 0,
      ladarHeatPerSec: 0,
    },
    weapons: {
      ammoCapacity: 0,
      laserDps: 0,
      laserRangeAu: 0,
      laserHeatPerSec: 0,
      ciwsRating: 0.05,
      gunDps: 0,
      droneCapacity: 0,
    },
    logistics: {
      cargoCapacity: 100,
      miningRatePerSec: 0,
      canResupply: false,
      canBuildShips: false,
    },
  },
  recon_corvette: {
    kind: 'recon_corvette',
    name: 'Recon / EW Corvette',
    category: 'combat',
    defaultPropulsion: 'electric',
    allowedPropulsions: ['electric', 'chemical'],
    buildLocation: 'home_base_only',
    costOre: 110,
    costPropellant: 35,
    buildTimeSec: 36,
    maxHp: 180,
    maxDeltaV: 0.032,
    maxHeat: 110,
    baseHeatGenPerSec: 0.25,
    radiatorCoolingPerSec: 1.8,
    passiveRadiatorIr: 2.2,
    rcs: 0.8,
    opticalCrossSection: 0.9,
    albedo: 0.12,
    sensors: {
      passiveIrSensitivity: 2.0,
      passiveOpticalSensitivity: 2.0,
      radarPower: 1.2,
      radarRangeAu: 0.28,
      esmSensitivity: 2.4,
      ladarRangeAu: 0.03,
      ladarConeRad: 0.22,
      ladarHeatPerSec: 2.4,
    },
    weapons: {
      ammoCapacity: 4,
      laserDps: 6,
      laserRangeAu: 0.015,
      laserHeatPerSec: 2.2,
      ciwsRating: 0.2,
      gunDps: 4,
      droneCapacity: 4,
    },
    logistics: {
      cargoCapacity: 0,
      miningRatePerSec: 0,
      canResupply: false,
      canBuildShips: false,
    },
  },
  escort_frigate: {
    kind: 'escort_frigate',
    name: 'Escort Air-Defense Frigate',
    category: 'combat',
    defaultPropulsion: 'chemical',
    allowedPropulsions: ['chemical'],
    buildLocation: 'home_base_only',
    costOre: 150,
    costPropellant: 45,
    buildTimeSec: 45,
    maxHp: 320,
    maxDeltaV: 0.015,
    maxHeat: 150,
    baseHeatGenPerSec: 0.4,
    radiatorCoolingPerSec: 2.8,
    passiveRadiatorIr: 4.5,
    rcs: 1.6,
    opticalCrossSection: 1.5,
    albedo: 0.25,
    sensors: {
      passiveIrSensitivity: 1.2,
      passiveOpticalSensitivity: 1.1,
      radarPower: 1.4,
      radarRangeAu: 0.24,
      esmSensitivity: 1.3,
      ladarRangeAu: 0.035,
      ladarConeRad: 0.3,
      ladarHeatPerSec: 3.2,
    },
    weapons: {
      ammoCapacity: 10,
      laserDps: 24,
      laserRangeAu: 0.025,
      laserHeatPerSec: 4.2,
      ciwsRating: 0.62,
      gunDps: 14,
      droneCapacity: 0,
    },
    logistics: {
      cargoCapacity: 0,
      miningRatePerSec: 0,
      canResupply: false,
      canBuildShips: false,
    },
  },
  raider: {
    kind: 'raider',
    name: 'Stealth Commerce Raider',
    category: 'combat',
    defaultPropulsion: 'chemical',
    allowedPropulsions: ['chemical', 'nuclear'],
    buildLocation: 'home_base_only',
    costOre: 185,
    costPropellant: 60,
    buildTimeSec: 54,
    maxHp: 280,
    maxDeltaV: 0.018,
    maxHeat: 220,
    baseHeatGenPerSec: 0.3,
    radiatorCoolingPerSec: 2.4,
    passiveRadiatorIr: 3.0,
    rcs: 0.7,
    opticalCrossSection: 0.85,
    albedo: 0.08,
    sensors: {
      passiveIrSensitivity: 1.6,
      passiveOpticalSensitivity: 1.6,
      radarPower: 0.9,
      radarRangeAu: 0.18,
      esmSensitivity: 1.8,
      ladarRangeAu: 0.02,
      ladarConeRad: 0.18,
      ladarHeatPerSec: 2.6,
    },
    weapons: {
      ammoCapacity: 12,
      laserDps: 10,
      laserRangeAu: 0.016,
      laserHeatPerSec: 2.8,
      ciwsRating: 0.3,
      gunDps: 16,
      droneCapacity: 2,
    },
    logistics: {
      cargoCapacity: 0,
      miningRatePerSec: 0,
      canResupply: false,
      canBuildShips: false,
    },
  },
  cruiser: {
    kind: 'cruiser',
    name: 'Nuclear Missile Cruiser',
    category: 'combat',
    defaultPropulsion: 'nuclear',
    allowedPropulsions: ['nuclear'],
    buildLocation: 'home_base_only',
    costOre: 320,
    costPropellant: 95,
    buildTimeSec: 85,
    maxHp: 680,
    maxDeltaV: 0.022,
    maxHeat: 320,
    baseHeatGenPerSec: 0.75,
    radiatorCoolingPerSec: 4.5,
    passiveRadiatorIr: 9.0,
    rcs: 3.4,
    opticalCrossSection: 3.0,
    albedo: 0.28,
    sensors: {
      passiveIrSensitivity: 1.4,
      passiveOpticalSensitivity: 1.4,
      radarPower: 2.2,
      radarRangeAu: 0.36,
      esmSensitivity: 1.6,
      ladarRangeAu: 0.032,
      ladarConeRad: 0.25,
      ladarHeatPerSec: 3.6,
    },
    weapons: {
      ammoCapacity: 24,
      laserDps: 20,
      laserRangeAu: 0.024,
      laserHeatPerSec: 4.0,
      ciwsRating: 0.48,
      gunDps: 24,
      droneCapacity: 3,
    },
    logistics: {
      cargoCapacity: 0,
      miningRatePerSec: 0,
      canResupply: false,
      canBuildShips: false,
    },
  },
  tanker: {
    kind: 'tanker',
    name: 'Fleet Propellant Tanker',
    category: 'civilian',
    defaultPropulsion: 'electric',
    allowedPropulsions: ['electric', 'chemical'],
    buildLocation: 'home_base_only',
    costOre: 125,
    costPropellant: 80,
    buildTimeSec: 40,
    maxHp: 240,
    maxDeltaV: 0.04,
    maxHeat: 120,
    baseHeatGenPerSec: 0.3,
    radiatorCoolingPerSec: 1.6,
    passiveRadiatorIr: 4.0,
    rcs: 3.6,
    opticalCrossSection: 3.4,
    albedo: 0.42,
    sensors: {
      passiveIrSensitivity: 0.8,
      passiveOpticalSensitivity: 0.8,
      radarPower: 0.5,
      radarRangeAu: 0.12,
      esmSensitivity: 0.9,
      ladarRangeAu: 0,
      ladarConeRad: 0,
      ladarHeatPerSec: 0,
    },
    weapons: {
      ammoCapacity: 8,
      laserDps: 0,
      laserRangeAu: 0,
      laserHeatPerSec: 0,
      ciwsRating: 0.15,
      gunDps: 0,
      droneCapacity: 0,
    },
    logistics: {
      cargoCapacity: 250,
      miningRatePerSec: 0,
      canResupply: true,
      canBuildShips: false,
    },
  },
  drone_recon: {
    kind: 'drone_recon',
    name: 'Recon / Triangulation Drone',
    category: 'drone',
    defaultPropulsion: 'electric',
    allowedPropulsions: ['electric', 'chemical'],
    buildLocation: 'carrier_launched',
    costOre: 18,
    costPropellant: 5,
    buildTimeSec: 10,
    maxHp: 35,
    maxDeltaV: 0.012,
    maxHeat: 30,
    baseHeatGenPerSec: 0.05,
    radiatorCoolingPerSec: 0.5,
    passiveRadiatorIr: 0.4,
    rcs: 0.2,
    opticalCrossSection: 0.25,
    albedo: 0.1,
    sensors: {
      passiveIrSensitivity: 1.5,
      passiveOpticalSensitivity: 1.5,
      radarPower: 0,
      radarRangeAu: 0,
      esmSensitivity: 1.7,
      ladarRangeAu: 0,
      ladarConeRad: 0,
      ladarHeatPerSec: 0,
    },
    weapons: {
      ammoCapacity: 0,
      laserDps: 0,
      laserRangeAu: 0,
      laserHeatPerSec: 0,
      ciwsRating: 0,
      gunDps: 0,
      droneCapacity: 0,
    },
    logistics: {
      cargoCapacity: 0,
      miningRatePerSec: 0,
      canResupply: false,
      canBuildShips: false,
    },
  },
  drone_ew: {
    kind: 'drone_ew',
    name: 'Electronic Warfare / Decoy Drone',
    category: 'drone',
    defaultPropulsion: 'electric',
    allowedPropulsions: ['electric', 'chemical'],
    buildLocation: 'carrier_launched',
    costOre: 22,
    costPropellant: 5,
    buildTimeSec: 12,
    maxHp: 40,
    maxDeltaV: 0.012,
    maxHeat: 45,
    baseHeatGenPerSec: 0.15,
    radiatorCoolingPerSec: 0.7,
    passiveRadiatorIr: 1.2,
    rcs: 3.5,
    opticalCrossSection: 1.2,
    albedo: 0.35,
    sensors: {
      passiveIrSensitivity: 0.6,
      passiveOpticalSensitivity: 0.6,
      radarPower: 1.6,
      radarRangeAu: 0.2,
      esmSensitivity: 1.2,
      ladarRangeAu: 0,
      ladarConeRad: 0,
      ladarHeatPerSec: 0,
    },
    weapons: {
      ammoCapacity: 0,
      laserDps: 0,
      laserRangeAu: 0,
      laserHeatPerSec: 0,
      ciwsRating: 0,
      gunDps: 0,
      droneCapacity: 0,
    },
    logistics: {
      cargoCapacity: 0,
      miningRatePerSec: 0,
      canResupply: false,
      canBuildShips: false,
    },
  },
};

export interface WonderConfig {
  slotCount: number;
  namesByFaction: Readonly<Record<FactionId, string>>;
  orePerSlot: number;
  buildTimePerSlotSec: number;
  maxConcurrentSlots: number;
  slotMaxHp: number;
  repairOreRatio: number;
  stabilizationHoldSec: number;
  ringSemiMajorAxisAu: Readonly<Record<FactionId, number>>;
}

export const WONDER_CONFIG: WonderConfig = {
  slotCount: 16,
  namesByFaction: {
    earth: 'Dyson Swarm Ring',
    mars: 'Martian Orbital Accelerator',
  },
  orePerSlot: 400,
  buildTimePerSlotSec: 120,
  maxConcurrentSlots: 2,
  slotMaxHp: 600,
  repairOreRatio: 0.35,
  stabilizationHoldSec: 60,
  ringSemiMajorAxisAu: {
    earth: 1.0,
    mars: 1.52,
  },
};

export const LOGISTICS_CONFIG = {
  initialFreighterCap: 3,
  freighterCapCostOre: 90,
  freighterCapBuildTimeSec: 25,
  freighterBatchCargo: 100,
  minBatchSize: 1,
  maxBatchSize: 3,
} as const;
