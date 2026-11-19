import {
  MUNITION_CONFIGS,
  UNIT_CONFIGS,
  isOccluded,
  type MunitionEntity,
  type OccluderBody,
  type SubsystemHealth,
  type UnitEntity,
  type UnitSubsystems,
} from '@space-war/shared';
import type { TickSystemHook } from '../engine/simulationLoop.js';
import { getWorldOccluders, type WorldState } from '../engine/worldState.js';
import { applyLaserDazzle } from './ew.js';
import { handleFreighterDestroyed } from './logistics.js';
import { getWeaponSubsystemFactor } from './munitions.js';
import { getThermalSubsystemFactor } from './thermal.js';

export const COMBAT_CONSTANTS = {
  closeGunRangeAu: 0.015,
  escortCiwsRangeAu: 0.035,
  salvoSaturationRadiusAu: 0.045,
  salvoSaturationPerMissile: 0.03,
  salvoSaturationMaxPenalty: 0.35,
  escortCiwsShareFactor: 0.95,
  laserAntiShipDamageScale: 0.45,
  laserAblationThreshold: 6.0,
  laserThermalCutoffRatio: 0.95,
} as const;

const SUBSYSTEM_KEYS: ReadonlyArray<keyof UnitSubsystems> = [
  'thermal',
  'sensors',
  'weapons',
  'propulsion',
];

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function deterministicUnitRoll(tick: number, aId: string, bId: string): number {
  let hash = 2166136261 ^ tick;
  const combined = `${aId}:${bId}`;
  for (let i = 0; i < combined.length; i++) {
    hash ^= combined.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967296;
}

export function degradeSubsystem(health: SubsystemHealth): SubsystemHealth {
  if (health === 'normal') return 'damaged';
  if (health === 'damaged') return 'offline';
  return 'offline';
}

/**
 * Checks whether a unit is thermally locked out from sustained propulsion burns due to
 * damaged/offline thermal subsystems and a saturated heat sink.
 */
export function isUnitThermallyLockedOut(unit: UnitEntity): boolean {
  if (unit.subsystems.thermal === 'offline' && unit.heat >= unit.maxHeat * 0.9) {
    return true;
  }
  if (unit.subsystems.thermal === 'damaged' && unit.heat >= unit.maxHeat * 0.99) {
    return true;
  }
  return false;
}

/**
 * Checks whether a unit is allowed to fire its short-range laser weapon.
 */
export function canUnitFireLaser(unit: UnitEntity): boolean {
  const cfg = UNIT_CONFIGS[unit.kind];
  if (
    unit.hp <= 0 ||
    unit.emconSilent ||
    cfg.weapons.laserDps <= 0 ||
    cfg.weapons.laserRangeAu <= 0
  ) {
    return false;
  }
  if (unit.subsystems.weapons === 'offline' || unit.subsystems.thermal === 'offline') {
    return false;
  }
  if (unit.heat >= unit.maxHeat * COMBAT_CONSTANTS.laserThermalCutoffRatio) {
    return false;
  }
  return true;
}

/**
 * Applies hull damage and progressive subsystem degradation to `target`,
 * triggering home-base defeat if a home_base reaches 0 HP.
 */
export function applyUnitDamage(
  world: WorldState,
  target: UnitEntity,
  damage: number,
  options: { preferredSubsystems?: ReadonlyArray<keyof UnitSubsystems>; forceSubsystemStep?: boolean } = {},
): UnitEntity {
  const latest = world.units.get(target.id) ?? target;
  if (latest.hp <= 0 || damage <= 0) {
    return latest;
  }

  const prevRatio = latest.hp / Math.max(1, latest.maxHp);
  const nextHp = Math.max(0, latest.hp - damage);
  const nextRatio = nextHp / Math.max(1, latest.maxHp);
  const nextSubsystems: UnitSubsystems = { ...latest.subsystems };

  const crossedThreshold =
    (prevRatio > 0.75 && nextRatio <= 0.75) ||
    (prevRatio > 0.5 && nextRatio <= 0.5) ||
    (prevRatio > 0.25 && nextRatio <= 0.25) ||
    damage >= latest.maxHp * 0.2;

  if (options.forceSubsystemStep || crossedThreshold) {
    const pool = options.preferredSubsystems ?? SUBSYSTEM_KEYS;
    const startIdx = options.preferredSubsystems
      ? 0
      : Math.abs(world.tick + latest.id.length) % pool.length;
    for (let offset = 0; offset < pool.length; offset++) {
      const key = pool[(startIdx + offset) % pool.length]!;
      if (nextSubsystems[key] !== 'offline') {
        nextSubsystems[key] = degradeSubsystem(nextSubsystems[key]);
        break;
      }
    }
  }

  const updated: UnitEntity = {
    ...latest,
    hp: nextHp,
    subsystems: nextSubsystems,
  };
  world.units.set(updated.id, updated);

  if (nextHp <= 0 && updated.kind === 'home_base' && world.winner === null) {
    world.winner = updated.faction === 'earth' ? 'mars' : 'earth';
  }
  if (nextHp <= 0 && updated.kind === 'freighter') {
    handleFreighterDestroyed(world, updated);
  }

  return updated;
}

/**
 * Computes numerical CIWS point-defense interception probability in [0.05, 0.90]:
 * `clamp(baseCiws * defenderThermalFactor - attackerSpeedPenalty - salvoSaturationPenalty, 0.05, 0.90)`
 * aggregating nearby friendly escorts within `COMBAT_CONSTANTS.escortCiwsRangeAu`.
 */
export function computeCiwsInterceptProbability(
  world: WorldState,
  munition: MunitionEntity,
  targetUnit: UnitEntity,
): number {
  const targetCfg = UNIT_CONFIGS[targetUnit.kind];
  const targetCiws =
    targetUnit.subsystems.weapons === 'offline'
      ? 0
      : targetCfg.weapons.ciwsRating * getWeaponSubsystemFactor(targetUnit.subsystems.weapons);

  let escortBonus = 0;
  for (const ally of world.units.values()) {
    if (
      ally.id === targetUnit.id ||
      ally.faction !== targetUnit.faction ||
      ally.hp <= 0 ||
      ally.subsystems.weapons === 'offline'
    ) {
      continue;
    }
    const dist = Math.hypot(ally.pos.x - targetUnit.pos.x, ally.pos.y - targetUnit.pos.y);
    if (dist <= COMBAT_CONSTANTS.escortCiwsRangeAu) {
      const allyCfg = UNIT_CONFIGS[ally.kind];
      escortBonus +=
        allyCfg.weapons.ciwsRating *
        getWeaponSubsystemFactor(ally.subsystems.weapons) *
        COMBAT_CONSTANTS.escortCiwsShareFactor;
    }
  }

  const baseCiws = targetCiws + Math.min(0.85, escortBonus);
  const heatRatio = targetUnit.heat / Math.max(1, targetUnit.maxHeat);
  const heatPenalty = heatRatio >= 0.85 ? 0.65 : 1.0;
  const thermalFactor =
    (0.5 + 0.5 * getThermalSubsystemFactor(targetUnit.subsystems.thermal)) * heatPenalty;

  const munCfg = MUNITION_CONFIGS[munition.profileId];
  const attackerSpeedPenalty = munCfg.ciwsEvasionPenalty;

  let concurrentIncoming = 0;
  for (const m of world.munitions.values()) {
    if (m.intercepted || m.faction === targetUnit.faction) {
      continue;
    }
    const d = Math.hypot(m.pos.x - targetUnit.pos.x, m.pos.y - targetUnit.pos.y);
    if (d <= COMBAT_CONSTANTS.salvoSaturationRadiusAu) {
      concurrentIncoming += 1;
    }
  }
  const salvoSaturationPenalty = Math.min(
    COMBAT_CONSTANTS.salvoSaturationMaxPenalty,
    Math.max(0, (concurrentIncoming - 1) * COMBAT_CONSTANTS.salvoSaturationPerMissile),
  );

  return clamp(
    baseCiws * thermalFactor - attackerSpeedPenalty - salvoSaturationPenalty,
    0.05,
    0.9,
  );
}

/**
 * Evaluates numerical CIWS point-defense interception when a munition reaches its target.
 */
export function evaluateCiwsIntercept(
  world: WorldState,
  munition: MunitionEntity,
  targetUnit: UnitEntity,
): boolean {
  const pIntercept = computeCiwsInterceptProbability(world, munition, targetUnit);
  const roll = deterministicUnitRoll(world.tick, munition.id, targetUnit.id);
  if (roll < pIntercept) {
    world.vfxEvents.push({
      kind: 'ciws',
      from: { ...targetUnit.pos },
      to: { ...munition.pos },
      intensity: 0.8,
    });
    return true;
  }
  return false;
}

/**
 * Applies warhead impact damage and subsystem hits to `targetUnit` upon CIWS penetration.
 */
export function applyMunitionWarheadImpact(
  world: WorldState,
  targetUnit: UnitEntity,
  damage: number,
  _munition: MunitionEntity,
): void {
  applyUnitDamage(world, targetUnit, damage);
}

/**
 * Runs 10Hz short-range laser point-defense (missile interception) and anti-ship
 * sensor/thermal subsystem ablation, registering laser heat via `world.laserActiveUnitIds`.
 */
export function stepLaserCombatSystem(world: WorldState, dtSec: number): void {
  let occluders: OccluderBody[] | null = null;
  const ensureOccluders = (): OccluderBody[] => {
    if (!occluders) {
      occluders = getWorldOccluders(world);
    }
    return occluders;
  };
  for (const attacker of world.units.values()) {
    if (!canUnitFireLaser(attacker)) {
      continue;
    }

    const cfg = UNIT_CONFIGS[attacker.kind];
    const weaponFactor = getWeaponSubsystemFactor(attacker.subsystems.weapons);
    const maxRange = cfg.weapons.laserRangeAu;

    // Priority 1: Intercept closest unoccluded enemy munition within laser range
    let bestMun: MunitionEntity | undefined;
    let bestMunDist = maxRange;
    for (const mun of world.munitions.values()) {
      if (mun.faction === attacker.faction || mun.intercepted) {
        continue;
      }
      const d = Math.hypot(mun.pos.x - attacker.pos.x, mun.pos.y - attacker.pos.y);
      if (d <= bestMunDist && !isOccluded(attacker.pos, mun.pos, ensureOccluders(), world.gameTimeSec)) {
        bestMunDist = d;
        bestMun = mun;
      }
    }

    if (bestMun) {
      const attenuation = Math.max(0.2, 1 - 0.75 * (bestMunDist / maxRange));
      const dmg = cfg.weapons.laserDps * weaponFactor * attenuation * dtSec;

      const munCfg = MUNITION_CONFIGS[bestMun.profileId];
      let meta = world.munitionMeta.get(bestMun.id);
      if (!meta) {
        meta = {
          launchedAtSec: world.gameTimeSec,
          maxFlightSec: 240,
          hp: munCfg.hp,
          aimPos: { ...bestMun.pos },
          aimVel: { ...bestMun.vel },
          targetKind: 'unit',
          seekerActive: !bestMun.coldCoast,
        };
        world.munitionMeta.set(bestMun.id, meta);
      }

      meta.hp = Math.max(0, meta.hp - dmg);
      if (meta.hp <= 0) {
        bestMun.intercepted = true;
        meta.interceptedAtTick = world.tick;
        world.vfxEvents.push({
          kind: 'ciws',
          from: { ...bestMun.pos },
          intensity: 0.85,
        });
      }

      world.laserActiveUnitIds.add(attacker.id);
      world.vfxEvents.push({
        kind: 'laser',
        from: { ...attacker.pos },
        to: { ...bestMun.pos },
        intensity: attenuation,
      });
      continue;
    }

    // Priority 2: Ablate closest unoccluded enemy unit's thermal/sensor subsystems
    let bestShip: UnitEntity | undefined;
    let bestShipDist = maxRange;
    for (const enemy of world.units.values()) {
      if (enemy.faction === attacker.faction || enemy.hp <= 0) {
        continue;
      }
      const d = Math.hypot(enemy.pos.x - attacker.pos.x, enemy.pos.y - attacker.pos.y);
      if (d <= bestShipDist && !isOccluded(attacker.pos, enemy.pos, ensureOccluders(), world.gameTimeSec)) {
        bestShipDist = d;
        bestShip = enemy;
      }
    }

    if (bestShip) {
      const attenuation = Math.max(0.2, 1 - 0.75 * (bestShipDist / maxRange));
      const rawDps = cfg.weapons.laserDps * weaponFactor * attenuation;
      const hullDmg = rawDps * COMBAT_CONSTANTS.laserAntiShipDamageScale * dtSec;

      const prevAblation = world.laserAblationByUnit.get(bestShip.id) ?? 0;
      let nextAblation = prevAblation + rawDps * dtSec;
      let triggerSubsystem = false;
      if (nextAblation >= COMBAT_CONSTANTS.laserAblationThreshold) {
        nextAblation -= COMBAT_CONSTANTS.laserAblationThreshold;
        triggerSubsystem = true;
      }
      world.laserAblationByUnit.set(bestShip.id, nextAblation);

      applyUnitDamage(world, bestShip, hullDmg, {
        preferredSubsystems: ['thermal', 'sensors'],
        forceSubsystemStep: triggerSubsystem,
      });
      applyLaserDazzle(world, attacker, bestShip);

      world.laserActiveUnitIds.add(attacker.id);
      world.vfxEvents.push({
        kind: 'laser',
        from: { ...attacker.pos },
        to: { ...bestShip.pos },
        intensity: attenuation,
      });
    }
  }
}

/**
 * Resolves pure numerical close-range gun DPS exchanges between opposing units within
 * `COMBAT_CONSTANTS.closeGunRangeAu` (no tactical mini-map switch).
 */
export function stepCloseRangeGunCombat(world: WorldState, dtSec: number): void {
  let occluders: OccluderBody[] | null = null;
  const ensureOccluders = (): OccluderBody[] => {
    if (!occluders) {
      occluders = getWorldOccluders(world);
    }
    return occluders;
  };
  const attackers = [...world.units.values()].filter(
    (u) => u.hp > 0 && u.subsystems.weapons !== 'offline' && UNIT_CONFIGS[u.kind].weapons.gunDps > 0,
  );

  for (const attacker of attackers) {
    const cfg = UNIT_CONFIGS[attacker.kind];
    const gunDps = cfg.weapons.gunDps * getWeaponSubsystemFactor(attacker.subsystems.weapons);
    if (gunDps <= 0) {
      continue;
    }

    let closestEnemy: UnitEntity | undefined;
    let closestDist: number = COMBAT_CONSTANTS.closeGunRangeAu;

    for (const target of world.units.values()) {
      if (target.faction === attacker.faction || target.hp <= 0) {
        continue;
      }
      const d = Math.hypot(target.pos.x - attacker.pos.x, target.pos.y - attacker.pos.y);
      if (d <= closestDist && !isOccluded(attacker.pos, target.pos, ensureOccluders(), world.gameTimeSec)) {
        closestDist = d;
        closestEnemy = target;
      }
    }

    if (closestEnemy) {
      applyUnitDamage(world, closestEnemy, gunDps * dtSec);
    }
  }
}

/**
 * Runs both short-range laser point defense/ablation and close-range numerical gun combat.
 */
export function stepCombatSystem(world: WorldState, dtSec: number): void {
  stepLaserCombatSystem(world, dtSec);
  stepCloseRangeGunCombat(world, dtSec);
}

/**
 * Creates a SimulationLoop system hook for laser & close-range numerical combat in `pre_thermal`.
 */
export function createCombatTickSystem(): TickSystemHook {
  return ({ world, dtSec }) => {
    stepCombatSystem(world, dtSec);
  };
}
