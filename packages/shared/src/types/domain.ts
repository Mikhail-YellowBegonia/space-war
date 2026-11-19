export type FactionId = 'earth' | 'mars';
export type PropulsionType = 'chemical' | 'nuclear' | 'electric';
export type TransferMode = 'fuel' | 'fast' | 'stealth';
export type TrackConfidence = 'bearing' | 'uncertain' | 'confirmed' | 'ghost';
export type ResourceType = 'ore' | 'propellant';
export type SubsystemHealth = 'normal' | 'damaged' | 'offline';

export type UnitKind =
  | 'home_base'
  | 'mining_outpost'
  | 'relay_depot'
  | 'freighter'
  | 'recon_corvette'
  | 'escort_frigate'
  | 'raider'
  | 'cruiser'
  | 'tanker'
  | 'drone_recon'
  | 'drone_ew';

export type MunitionProfileId = 'light_interceptor' | 'heavy_torpedo';
export type MunitionSeekerMode = 'ir' | 'radar' | 'inertial_then_active';
export type WonderSlotStatus = 'empty' | 'building' | 'complete' | 'damaged_halted';
export type BingoWarningLevel = 'safe' | 'amber' | 'red';
export type SuspectedTrackKind = 'unknown' | 'ship' | 'freighter' | 'munition' | 'station';
export type VfxEventKind = 'laser' | 'ciws' | 'explosion' | 'burn_flash';

/**
 * 2D Cartesian vector in heliocentric ecliptic coordinates (AU or AU/s, float64).
 */
export interface Vec2 {
  x: number;
  y: number;
}

/**
 * Planar 2-body Keplerian orbital elements around the Sun.
 */
export interface KeplerOrbit {
  /** Semi-major axis in AU. */
  a: number;
  /** Eccentricity in [0, 1). */
  e: number;
  /** Argument of periapsis in radians. */
  omega: number;
  /** Mean anomaly at epochSec in radians. */
  meanAnomaly0: number;
  /** Reference simulation time in game seconds. */
  epochSec: number;
}

/**
 * Static and orbital definition of a celestial body in the inner solar system.
 */
export interface CelestialBody {
  id: string;
  name: string;
  /** Null for the central Sun; Keplerian orbit for planets and asteroids. */
  orbit: KeplerOrbit | null;
  /** Exaggerated display radius in AU. */
  visualRadiusAu: number;
  /** Line-of-sight occlusion and collision radius in AU. */
  occlusionRadiusAu: number;
  /** Effective anti-sunward solar umbra length in AU. */
  umbraLengthAu: number;
  /** Base extraction yields by resource type. */
  yields: Partial<Record<ResourceType, number>>;
  /** Home base faction binding for Earth and Mars. */
  ownerSlot?: FactionId;
}

/**
 * Planned orbital maneuver burn.
 */
export interface TransferBurn {
  executeAtSec: number;
  /** Delta-v vector in AU/s. */
  deltaV: Vec2;
  /** Short impulse for chemical/nuclear; continuous thrust window for electric. */
  durationSec: number;
  /** True when a nuclear stealth burn begins inside a celestial occlusion cone. */
  isOccludedStart: boolean;
}

/**
 * Candidate transfer plan computed by the shared solver.
 */
export interface TransferOption {
  mode: TransferMode;
  feasible: boolean;
  reason?: string;
  burns: TransferBurn[];
  previewOrbitSegments: KeplerOrbit[];
  arrivalSec: number;
  totalDeltaV: number;
  /** Normalized infrared exposure risk in [0, 1]. */
  estimatedPeakIr: number;
  /** Conservative minimum delta-v required to return to nearest friendly resupply. */
  bingoDeltaV: number;
  bingoWarning: BingoWarningLevel;
}

export interface UnitSubsystems {
  propulsion: SubsystemHealth;
  sensors: SubsystemHealth;
  weapons: SubsystemHealth;
  thermal: SubsystemHealth;
}

/**
 * Authoritative unit state for ships, stations, freighters, and drones.
 */
export interface UnitEntity {
  id: string;
  faction: FactionId;
  kind: UnitKind;
  propulsion: PropulsionType;
  pos: Vec2;
  vel: Vec2;
  orbit: KeplerOrbit;
  hp: number;
  maxHp: number;
  subsystems: UnitSubsystems;
  deltaV: number;
  maxDeltaV: number;
  /** Current internal heat sink load. */
  heat: number;
  /** Maximum heat sink capacity before forced venting or thermal throttling. */
  maxHeat: number;
  /** Open radiators cool rapidly at the cost of high IR signature. */
  radiatorsOpen: boolean;
  /** EMCON silent mode retracts radiators and disables active radar. */
  emconSilent: boolean;
  radarActive: boolean;
  jammerActive: boolean;
  /** Active LADAR scan centerline angle in radians when enabled. */
  ladarTargetAngle?: number;
  cargo?: Partial<Record<ResourceType, number>>;
  ammoStock: number;
  plannedBurns: TransferBurn[];
}

/**
 * Unified guided/ballistic munition entity shared by missiles, torpedoes, and interceptors.
 */
export interface MunitionEntity {
  id: string;
  faction: FactionId;
  profileId: MunitionProfileId;
  pos: Vec2;
  vel: Vec2;
  orbit: KeplerOrbit;
  deltaV: number;
  /** Target unit, station, or in-flight enemy munition ID. */
  targetId: string;
  seekerMode: MunitionSeekerMode;
  /** True while coasting silently prior to terminal activation. */
  coldCoast: boolean;
  intercepted?: boolean;
}

/**
 * Faction-filtered sensor track representing perceived enemy presence.
 * Never exposes true enemy entity IDs on unconfirmed/bearing tracks.
 */
export interface SensorTrack {
  trackId: string;
  confidence: TrackConfidence;
  suspectedKind: SuspectedTrackKind;
  /** Required when confidence is 'bearing'. */
  bearingRad?: number;
  originPos?: Vec2;
  /** Estimated center for uncertain, confirmed, or ghost tracks. */
  pos?: Vec2;
  vel?: Vec2;
  errorRadiusMajorAu?: number;
  errorRadiusMinorAu?: number;
  errorAngleRad?: number;
  estimatedOrbit?: KeplerOrbit;
  lastObservedSec: number;
  isJammed: boolean;
}

/**
 * Automated pooled logistics route configuration.
 */
export interface LogisticsRoute {
  id: string;
  faction: FactionId;
  sourceBodyId: string;
  targetId: string;
  resource: ResourceType;
  paused: boolean;
  /** 1 for single-ship dispatch; 2-3 for convoy batching. */
  batchSize: number;
  transferMode: TransferMode;
  detourWaypoint?: Vec2;
  escortUnitIds: string[];
}

/**
 * One of the 16 co-orbital wonder construction slots around a faction home base.
 */
export interface WonderSlot {
  index: number;
  status: WonderSlotStatus;
  progressOre: number;
  requiredOre: number;
  hp: number;
  maxHp: number;
}

export type BuildQueueKind =
  | 'freighter_cap'
  | 'outpost'
  | 'relay_depot'
  | UnitKind
  | 'wonder_slot';

/**
 * Commands issued from a client (or AI) to the authoritative simulation loop.
 */
export type PlayerCommand =
  | {
      type: 'plan_orbit_insertion';
      unitId: string;
      targetOrbit: KeplerOrbit;
      mode: TransferMode;
    }
  | {
      type: 'plan_intercept';
      unitId: string;
      targetRefId: string;
      mode: TransferMode;
    }
  | {
      type: 'set_emcon';
      unitId: string;
      silent: boolean;
      radiatorsOpen: boolean;
      radarActive: boolean;
      jammerActive: boolean;
    }
  | {
      type: 'set_ladar';
      unitId: string;
      angleRad: number | null;
    }
  | {
      type: 'launch_drone';
      unitId: string;
      droneKind: 'drone_recon' | 'drone_ew';
      targetOrbit?: KeplerOrbit;
    }
  | {
      type: 'fire_munition';
      unitId: string;
      targetTrackId: string;
      profileId: MunitionProfileId;
      count: number;
      coldCoast: boolean;
    }
  | {
      type: 'update_route';
      routeId: string;
      patch: Partial<Omit<LogisticsRoute, 'id' | 'faction'>>;
    }
  | {
      type: 'queue_build';
      kind: BuildQueueKind;
      targetRef?: string | Vec2;
    };

export interface CelestialSnapshotState {
  id: string;
  pos: Vec2;
  vel: Vec2;
}

export interface VfxEvent {
  kind: VfxEventKind;
  from: Vec2;
  to?: Vec2;
  intensity: number;
}

/**
 * Per-faction authoritative snapshot transmitted at the end of a simulation tick.
 */
export interface FactionSnapshot {
  tick: number;
  gameTimeSec: number;
  faction: FactionId;
  resources: Record<ResourceType, number>;
  freighterCap: number;
  freightersInFlight: number;
  celestials: CelestialSnapshotState[];
  ownUnits: UnitEntity[];
  ownMunitions: MunitionEntity[];
  tracks: SensorTrack[];
  routes: LogisticsRoute[];
  ownWonder: WonderSlot[];
  enemyWonderPublicProgress: number;
  vfxEvents: VfxEvent[];
  winner?: FactionId | null;
}
