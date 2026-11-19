import {
  MUNITION_CONFIGS,
  UNIT_CONFIGS,
  getSolarGlareFactor,
  isInUmbra,
  isOccluded,
  orbitToState,
  stateToOrbit,
  type FactionId,
  type KeplerOrbit,
  type MunitionEntity,
  type SensorTrack,
  type SubsystemHealth,
  type SuspectedTrackKind,
  type UnitEntity,
  type Vec2,
} from '@space-war/shared';
import type { TickSystemHook } from '../engine/simulationLoop.js';
import type { InternalTrackRecord, WorldState } from '../engine/worldState.js';
import { EW_CONSTANTS } from './ew.js';
import { computeUnitIrSignature } from './thermal.js';

export const SENSOR_CONSTANTS = {
  irNorm: 80,
  optNorm: 4.5,
  esmNorm: 1.4,
  jammerEsmPower: 4.5,
  jammerEffectRangeAu: 0.35,
  jammerErrorMultiplier: 6.0,
  minParallaxAngleRad: (3 * Math.PI) / 180,
  confirmedParallaxAngleRad: (5 * Math.PI) / 180,
  confirmedPassiveSnrThreshold: 8.0,
  confirmedPassiveMaxRangeAu: 0.25,
  ghostTtlSec: 45,
  transientTrackTtlSec: 4,
  dazzleSuppressionFactor: 0.05,
} as const;

export interface ChannelEvaluation {
  occluded: boolean;
  inUmbra: boolean;
  glareFactor: number;
  distanceAu: number;
  bearingRad: number;
  snrIr: number;
  snrOptical: number;
  snrRadar: number;
  snrEsm: number;
  ladarHit: boolean;
}

interface TargetSignatureView {
  id: string;
  faction: FactionId;
  pos: Vec2;
  vel: Vec2;
  orbit: KeplerOrbit;
  suspectedKind: SuspectedTrackKind;
  irSignature: number;
  rcs: number;
  opticalCrossSection: number;
  albedo: number;
  rfEmitPower: number;
}

interface PairObservation {
  observer: UnitEntity;
  channels: ChannelEvaluation;
  hasPassiveBearing: boolean;
  hasPassiveNonRf: boolean;
  hasHighSnrPassive: boolean;
  hasRadar: boolean;
  hasLadar: boolean;
  hasEsm: boolean;
}

export function getSensorSubsystemFactor(health: SubsystemHealth): number {
  switch (health) {
    case 'normal':
      return 1.0;
    case 'damaged':
      return 0.5;
    case 'offline':
      return 0;
  }
}

function wrapSignedAngle(rad: number): number {
  let wrapped = (rad + Math.PI) % (2 * Math.PI);
  if (wrapped < 0) {
    wrapped += 2 * Math.PI;
  }
  return wrapped - Math.PI;
}

function classifyUnitSuspectedKind(unit: UnitEntity): SuspectedTrackKind {
  switch (unit.kind) {
    case 'home_base':
    case 'mining_outpost':
    case 'relay_depot':
      return 'station';
    case 'freighter':
    case 'tanker':
      return 'freighter';
    case 'drone_ew':
      // EW decoys deliberately mimic combat ship / freighter signatures
      return 'ship';
    default:
      return 'ship';
  }
}

function buildTargetView(
  entity: UnitEntity | MunitionEntity,
  irByUnit?: ReadonlyMap<string, number>,
): TargetSignatureView {
  if ('profileId' in entity) {
    const cfg = MUNITION_CONFIGS[entity.profileId];
    const ir = entity.coldCoast ? 0.15 : cfg.baseIr * 8;
    const rfEmitPower = !entity.coldCoast && entity.seekerMode === 'radar' ? 1.0 : 0;
    return {
      id: entity.id,
      faction: entity.faction,
      pos: entity.pos,
      vel: entity.vel,
      orbit: entity.orbit,
      suspectedKind: 'munition',
      irSignature: ir,
      rcs: cfg.rcs,
      opticalCrossSection: 0.25,
      albedo: 0.15,
      rfEmitPower,
    };
  }

  const cfg = UNIT_CONFIGS[entity.kind];
  const baseIr = irByUnit?.get(entity.id) ?? computeUnitIrSignature(entity);
  const ir =
    entity.kind === 'drone_ew' && !entity.emconSilent
      ? baseIr * EW_CONSTANTS.droneEwDecoyIrBoost
      : baseIr;
  const radarPower =
    entity.radarActive && !entity.emconSilent && entity.subsystems.sensors !== 'offline'
      ? cfg.sensors.radarPower
      : 0;
  const jammerPower =
    entity.jammerActive && !entity.emconSilent && entity.subsystems.sensors !== 'offline'
      ? SENSOR_CONSTANTS.jammerEsmPower
      : 0;

  return {
    id: entity.id,
    faction: entity.faction,
    pos: entity.pos,
    vel: entity.vel,
    orbit: entity.orbit,
    suspectedKind: classifyUnitSuspectedKind(entity),
    irSignature: ir,
    rcs: cfg.rcs,
    opticalCrossSection: cfg.opticalCrossSection,
    albedo: cfg.albedo,
    rfEmitPower: radarPower + jammerPower,
  };
}

/**
 * Evaluates all 5 sensor channels (passive IR, passive optical, active radar, passive ESM, LADAR)
 * for a single observer unit against a target entity or signature view.
 */
export function evaluateSensorChannels(
  observer: UnitEntity,
  target: UnitEntity | MunitionEntity | TargetSignatureView,
  world: WorldState,
  irByUnit?: ReadonlyMap<string, number>,
): ChannelEvaluation {
  const view = 'suspectedKind' in target ? target : buildTargetView(target, irByUnit);
  const dx = view.pos.x - observer.pos.x;
  const dy = view.pos.y - observer.pos.y;
  const distanceAu = Math.max(1e-4, Math.hypot(dx, dy));
  const bearingRad = Math.atan2(dy, dx);

  const sensorFactor = getSensorSubsystemFactor(observer.subsystems.sensors);
  if (sensorFactor <= 0) {
    return {
      occluded: false,
      inUmbra: false,
      glareFactor: 1,
      distanceAu,
      bearingRad,
      snrIr: 0,
      snrOptical: 0,
      snrRadar: 0,
      snrEsm: 0,
      ladarHit: false,
    };
  }

  const occluded = isOccluded(observer.pos, view.pos, world.celestials, world.gameTimeSec);
  if (occluded) {
    return {
      occluded: true,
      inUmbra: false,
      glareFactor: 1,
      distanceAu,
      bearingRad,
      snrIr: 0,
      snrOptical: 0,
      snrRadar: 0,
      snrEsm: 0,
      ladarHit: false,
    };
  }

  const obsCfg = UNIT_CONFIGS[observer.kind];
  const rDistSq = distanceAu * distanceAu;
  const rTargetSun = Math.max(0.15, Math.hypot(view.pos.x, view.pos.y));
  const solarBgNoise = 1 + 0.5 / (rTargetSun * rTargetSun);
  const glareFactor = getSolarGlareFactor(observer.pos, view.pos);

  const blindUntil = world.sensorBlindUntilSec.get(observer.id) ?? 0;
  const dazzleFactor =
    world.gameTimeSec < blindUntil ? SENSOR_CONSTANTS.dazzleSuppressionFactor : 1.0;

  // 1. Passive Infrared (1 / R^2, attenuated by solar background noise & glare)
  const snrIr =
    (view.irSignature *
      obsCfg.sensors.passiveIrSensitivity *
      sensorFactor *
      glareFactor *
      dazzleFactor) /
    (rDistSq * solarBgNoise * SENSOR_CONSTANTS.irNorm);

  // 2. Passive Optical (0 inside planetary umbra, attenuated by sun flux & glare)
  const inUmbra = isInUmbra(view.pos, world.celestials, world.gameTimeSec);
  let snrOptical = 0;
  if (!inUmbra) {
    const sunFlux = 1 / (rTargetSun * rTargetSun);
    const opticalSignal = sunFlux * view.opticalCrossSection * view.albedo;
    snrOptical =
      (opticalSignal *
        obsCfg.sensors.passiveOpticalSensitivity *
        sensorFactor *
        glareFactor *
        dazzleFactor) /
      (rDistSq * SENSOR_CONSTANTS.optNorm);
  }

  // 3. Active Radar (1 / R^4)
  let snrRadar = 0;
  if (
    observer.radarActive &&
    !observer.emconSilent &&
    obsCfg.sensors.radarPower > 0 &&
    obsCfg.sensors.radarRangeAu > 0
  ) {
    const effRange = obsCfg.sensors.radarRangeAu * sensorFactor;
    snrRadar = Math.pow(effRange / distanceAu, 4) * view.rcs;
  }

  // 4. Passive ESM (1 / R^2 against active enemy radar/jammer/seeker)
  let snrEsm = 0;
  if (view.rfEmitPower > 0 && obsCfg.sensors.esmSensitivity > 0) {
    snrEsm =
      (view.rfEmitPower * obsCfg.sensors.esmSensitivity * sensorFactor) /
      (rDistSq * SENSOR_CONSTANTS.esmNorm);
  }

  // 5. LADAR (short-range narrow directional cone, immune to RF jamming)
  let ladarHit = false;
  if (
    observer.ladarTargetAngle !== undefined &&
    !observer.emconSilent &&
    obsCfg.sensors.ladarRangeAu > 0 &&
    obsCfg.sensors.ladarConeRad > 0
  ) {
    const maxLadarRange = obsCfg.sensors.ladarRangeAu * sensorFactor;
    const angleDiff = Math.abs(wrapSignedAngle(bearingRad - observer.ladarTargetAngle));
    if (distanceAu <= maxLadarRange && angleDiff <= obsCfg.sensors.ladarConeRad * 0.5) {
      ladarHit = true;
    }
  }

  return {
    occluded: false,
    inUmbra,
    glareFactor,
    distanceAu,
    bearingRad,
    snrIr,
    snrOptical,
    snrRadar,
    snrEsm,
    ladarHit,
  };
}

function isPointNearSegment(point: Vec2, segA: Vec2, segB: Vec2, maxDistAu: number): boolean {
  const dx = segB.x - segA.x;
  const dy = segB.y - segA.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-12) {
    return Math.hypot(point.x - segA.x, point.y - segA.y) <= maxDistAu;
  }
  const rawT = ((point.x - segA.x) * dx + (point.y - segA.y) * dy) / lenSq;
  const t = Math.max(0, Math.min(1, rawT));
  const cx = segA.x + t * dx - point.x;
  const cy = segA.y + t * dy - point.y;
  return cx * cx + cy * cy <= maxDistAu * maxDistAu;
}

function isTargetJammed(
  world: WorldState,
  targetPos: Vec2,
  targetFaction: FactionId,
  observerPositions: readonly Vec2[],
): boolean {
  for (const unit of world.units.values()) {
    if (
      unit.faction !== targetFaction ||
      unit.hp <= 0 ||
      !unit.jammerActive ||
      unit.emconSilent ||
      unit.subsystems.sensors === 'offline'
    ) {
      continue;
    }
    const dist = Math.hypot(unit.pos.x - targetPos.x, unit.pos.y - targetPos.y);
    if (dist <= SENSOR_CONSTANTS.jammerEffectRangeAu) {
      return true;
    }
    for (const obsPos of observerPositions) {
      if (isPointNearSegment(unit.pos, obsPos, targetPos, 0.12)) {
        return true;
      }
    }
  }
  return false;
}

interface TriangulationResult {
  pos: Vec2;
  maxParallaxRad: number;
  errorMajorAu: number;
  errorMinorAu: number;
  errorAngleRad: number;
}

function triangulatePassiveBearings(
  observations: readonly PairObservation[],
  onlyNonRf: boolean,
): TriangulationResult | null {
  const candidates = onlyNonRf
    ? observations.filter((o) => o.hasPassiveNonRf)
    : observations.filter((o) => o.hasPassiveBearing);

  if (candidates.length < 2) {
    return null;
  }

  let bestPair: [PairObservation, PairObservation] | null = null;
  let bestAngle = 0;

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i]!;
      const b = candidates[j]!;
      const sep = Math.abs(wrapSignedAngle(a.channels.bearingRad - b.channels.bearingRad));
      const folded = Math.min(sep, Math.PI - sep);
      if (folded > bestAngle) {
        bestAngle = folded;
        bestPair = [a, b];
      }
    }
  }

  if (!bestPair || bestAngle <= SENSOR_CONSTANTS.minParallaxAngleRad) {
    return null;
  }

  const [obsA, obsB] = bestPair;
  const ax = obsA.observer.pos.x;
  const ay = obsA.observer.pos.y;
  const adx = Math.cos(obsA.channels.bearingRad);
  const ady = Math.sin(obsA.channels.bearingRad);

  const bx = obsB.observer.pos.x;
  const by = obsB.observer.pos.y;
  const bdx = Math.cos(obsB.channels.bearingRad);
  const bdy = Math.sin(obsB.channels.bearingRad);

  const denom = adx * bdy - ady * bdx;
  if (Math.abs(denom) < 1e-6) {
    return null;
  }

  const dx = bx - ax;
  const dy = by - ay;
  const tA = (dx * bdy - dy * bdx) / denom;
  const tB = (dx * ady - dy * adx) / denom;

  if (tA <= 0 || tB <= 0) {
    return null;
  }

  const pos: Vec2 = {
    x: ax + tA * adx,
    y: ay + tA * ady,
  };
  const avgDist = 0.5 * (tA + tB);
  const sinSep = Math.max(0.05, Math.sin(bestAngle));
  const major = Math.min(0.3, (0.008 * avgDist) / sinSep);
  const minor = Math.max(0.002, major * 0.25);

  return {
    pos,
    maxParallaxRad: bestAngle,
    errorMajorAu: major,
    errorMinorAu: minor,
    errorAngleRad: wrapSignedAngle(
      obsA.channels.bearingRad +
        0.5 * wrapSignedAngle(obsB.channels.bearingRad - obsA.channels.bearingRad),
    ),
  };
}

function deterministicJitter(id: string, tick: number, scale: number): Vec2 {
  let hash = tick * 2654435761;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  const angle = ((hash & 0xffff) / 0xffff) * 2 * Math.PI;
  const mag = (((hash >>> 16) & 0xff) / 255) * scale;
  return {
    x: Math.cos(angle) * mag,
    y: Math.sin(angle) * mag,
  };
}

function sanitizeTrack(record: InternalTrackRecord): SensorTrack {
  switch (record.confidence) {
    case 'bearing':
      return {
        trackId: record.trackId,
        confidence: 'bearing',
        suspectedKind: record.suspectedKind,
        bearingRad: record.bearingRad ?? 0,
        originPos: record.originPos ? { ...record.originPos } : { x: 0, y: 0 },
        lastObservedSec: record.lastObservedSec,
        isJammed: record.isJammed,
      };

    case 'uncertain':
      return {
        trackId: record.trackId,
        confidence: 'uncertain',
        suspectedKind: record.suspectedKind,
        pos: record.pos ? { ...record.pos } : undefined,
        vel: record.vel ? { ...record.vel } : undefined,
        errorRadiusMajorAu: record.errorRadiusMajorAu,
        errorRadiusMinorAu: record.errorRadiusMinorAu,
        errorAngleRad: record.errorAngleRad,
        lastObservedSec: record.lastObservedSec,
        isJammed: record.isJammed,
      };

    case 'confirmed':
    case 'ghost':
      return {
        trackId: record.trackId,
        confidence: record.confidence,
        suspectedKind: record.suspectedKind,
        pos: record.pos ? { ...record.pos } : undefined,
        vel: record.vel ? { ...record.vel } : undefined,
        errorRadiusMajorAu: record.errorRadiusMajorAu,
        errorRadiusMinorAu: record.errorRadiusMinorAu,
        errorAngleRad: record.errorAngleRad,
        estimatedOrbit: record.lastConfirmedOrbit ? { ...record.lastConfirmedOrbit } : undefined,
        lastObservedSec: record.lastObservedSec,
        isJammed: record.isJammed,
      };
  }
}

function allocateTrackId(world: WorldState, faction: FactionId): string {
  const seq = world.nextTrackSeqByFaction[faction];
  world.nextTrackSeqByFaction[faction] = seq + 1;
  return `trk-${faction}-${seq}`;
}

/**
 * Recomputes authoritative fog-of-war SensorTrack[] for `observerFaction`.
 * Strictly enforces that undetected targets never appear in snapshots and bearing-only
 * tracks never expose true target coordinates or orbits.
 */
export function updateFactionSensors(
  world: WorldState,
  observerFaction: FactionId,
  irByUnit?: ReadonlyMap<string, number>,
): SensorTrack[] {
  const memory = world.trackMemoryByFaction[observerFaction];
  const observers: UnitEntity[] = [];
  for (const unit of world.units.values()) {
    if (unit.faction === observerFaction && unit.hp > 0) {
      observers.push(unit);
    }
  }

  const enemyTargets: TargetSignatureView[] = [];
  for (const unit of world.units.values()) {
    if (unit.faction !== observerFaction && unit.hp > 0) {
      enemyTargets.push(buildTargetView(unit, irByUnit));
    }
  }
  for (const munition of world.munitions.values()) {
    if (munition.faction !== observerFaction && !munition.intercepted) {
      enemyTargets.push(buildTargetView(munition, irByUnit));
    }
  }

  const activeTargetIds = new Set<string>();

  for (const target of enemyTargets) {
    const observations: PairObservation[] = [];

    for (const observer of observers) {
      const ch = evaluateSensorChannels(observer, target, world, irByUnit);
      if (ch.occluded) {
        continue;
      }

      const hasIr = ch.snrIr >= 1.0;
      const hasOpt = ch.snrOptical >= 1.0;
      const hasEsm = ch.snrEsm >= 1.0;
      const hasRadar = ch.snrRadar >= 1.0;
      const hasLadar = ch.ladarHit;
      const hasPassiveNonRf = hasIr || hasOpt;
      const hasPassiveBearing = hasPassiveNonRf || hasEsm;
      const hasHighSnrPassive =
        (ch.snrIr >= SENSOR_CONSTANTS.confirmedPassiveSnrThreshold ||
          ch.snrOptical >= SENSOR_CONSTANTS.confirmedPassiveSnrThreshold) &&
        ch.distanceAu <= SENSOR_CONSTANTS.confirmedPassiveMaxRangeAu;

      if (hasPassiveBearing || hasRadar || hasLadar) {
        observations.push({
          observer,
          channels: ch,
          hasPassiveBearing,
          hasPassiveNonRf,
          hasHighSnrPassive,
          hasRadar,
          hasLadar,
          hasEsm,
        });
      }
    }

    if (observations.length === 0) {
      continue;
    }

    activeTargetIds.add(target.id);
    const jammed = isTargetJammed(
      world,
      target.pos,
      target.faction,
      observations.map((o) => o.observer.pos),
    );
    const nonRfTri = triangulatePassiveBearings(observations, true);
    const anyTri = nonRfTri ?? triangulatePassiveBearings(observations, false);

    const hasLadar = observations.some((o) => o.hasLadar);
    const hasRadar = observations.some((o) => o.hasRadar);
    const hasHighSnrPassive = observations.some((o) => o.hasHighSnrPassive);

    const existing = memory.get(target.id);
    const trackId = existing?.trackId ?? allocateTrackId(world, observerFaction);

    let record: InternalTrackRecord;

    if (
      hasLadar ||
      (hasRadar && !jammed) ||
      hasHighSnrPassive ||
      (nonRfTri !== null && nonRfTri.maxParallaxRad >= SENSOR_CONSTANTS.confirmedParallaxAngleRad)
    ) {
      // CONFIRMED lock
      const estPos =
        !hasLadar && !hasRadar && !hasHighSnrPassive && nonRfTri !== null
          ? nonRfTri.pos
          : { ...target.pos };
      record = {
        trackId,
        targetId: target.id,
        confidence: 'confirmed',
        suspectedKind: target.suspectedKind,
        pos: estPos,
        vel: { ...target.vel },
        errorRadiusMajorAu: 0.002,
        errorRadiusMinorAu: 0.002,
        errorAngleRad: 0,
        lastConfirmedOrbit: { ...target.orbit },
        lastObservedSec: world.gameTimeSec,
        isJammed: false,
      };
    } else if ((hasRadar && jammed) || anyTri !== null) {
      // UNCERTAIN error ellipse (either jammed radar or parallax/triangulation under uncertainty)
      const baseMajor = anyTri?.errorMajorAu ?? 0.015;
      const baseMinor = anyTri?.errorMinorAu ?? 0.008;
      const mult = jammed ? SENSOR_CONSTANTS.jammerErrorMultiplier : 1.0;
      const major = baseMajor * mult;
      const minor = baseMinor * mult;
      const center = anyTri?.pos ?? target.pos;
      const offset = jammed
        ? deterministicJitter(target.id, world.tick, major * 0.25)
        : { x: 0, y: 0 };

      record = {
        trackId,
        targetId: target.id,
        confidence: 'uncertain',
        suspectedKind: target.suspectedKind,
        pos: { x: center.x + offset.x, y: center.y + offset.y },
        vel: { ...target.vel },
        errorRadiusMajorAu: major,
        errorRadiusMinorAu: minor,
        errorAngleRad: anyTri?.errorAngleRad ?? 0,
        lastConfirmedOrbit: existing?.lastConfirmedOrbit,
        lastObservedSec: world.gameTimeSec,
        isJammed: jammed,
      };
    } else {
      // BEARING-ONLY line (single-node passive IR / optical / ESM)
      const bestPassive = observations.reduce((best, cur) => {
        const curScore = Math.max(cur.channels.snrIr, cur.channels.snrOptical, cur.channels.snrEsm);
        const bestScore = Math.max(best.channels.snrIr, best.channels.snrOptical, best.channels.snrEsm);
        return curScore > bestScore ? cur : best;
      });

      record = {
        trackId,
        targetId: target.id,
        confidence: 'bearing',
        suspectedKind: bestPassive.hasPassiveNonRf ? target.suspectedKind : 'unknown',
        bearingRad: bestPassive.channels.bearingRad,
        originPos: { ...bestPassive.observer.pos },
        lastConfirmedOrbit: existing?.lastConfirmedOrbit,
        lastObservedSec: world.gameTimeSec,
        isJammed: jammed && bestPassive.hasEsm && !bestPassive.hasPassiveNonRf,
      };
    }

    memory.set(target.id, record);
  }

  // Emit LADAR sweep alerts for any friendly unit illuminated by an otherwise-undetected enemy LADAR
  for (const unit of world.units.values()) {
    if (unit.faction === observerFaction || unit.hp <= 0 || unit.ladarTargetAngle === undefined) {
      continue;
    }
    if (unit.emconSilent || unit.subsystems.sensors === 'offline') {
      continue;
    }
    const alertId = `ladar-warn-${unit.id}`;
    if (activeTargetIds.has(unit.id)) {
      memory.delete(alertId);
      continue;
    }
    for (const friendly of observers) {
      const ch = evaluateSensorChannels(unit, friendly, world, irByUnit);
      if (!ch.occluded && ch.ladarHit) {
        const existingAlert = memory.get(alertId);
        const trackId = existingAlert?.trackId ?? allocateTrackId(world, observerFaction);
        const bearingToSource = Math.atan2(unit.pos.y - friendly.pos.y, unit.pos.x - friendly.pos.x);
        const alertRecord: InternalTrackRecord = {
          trackId,
          targetId: unit.id,
          confidence: 'bearing',
          suspectedKind: 'ship',
          bearingRad: bearingToSource,
          originPos: { ...friendly.pos },
          lastObservedSec: world.gameTimeSec,
          isJammed: false,
        };
        memory.set(alertId, alertRecord);
        activeTargetIds.add(alertId);
        break;
      }
    }
  }

  // Persist / decay lost tracks -> ghost or expire
  const output: SensorTrack[] = [];
  for (const [targetId, record] of memory.entries()) {
    if (targetId.startsWith('ladar-warn-') && activeTargetIds.has(record.targetId)) {
      memory.delete(targetId);
      continue;
    }

    if (activeTargetIds.has(targetId)) {
      output.push(sanitizeTrack(record));
      continue;
    }

    const ageSec = world.gameTimeSec - record.lastObservedSec;
    if (record.lastConfirmedOrbit && ageSec <= SENSOR_CONSTANTS.ghostTtlSec) {
      const ghostState = orbitToState(record.lastConfirmedOrbit, world.gameTimeSec);
      const ghostRecord: InternalTrackRecord = {
        ...record,
        confidence: 'ghost',
        pos: ghostState.pos,
        vel: ghostState.vel,
        isJammed: false,
      };
      memory.set(targetId, ghostRecord);
      output.push(sanitizeTrack(ghostRecord));
    } else if (
      (record.confidence === 'bearing' || record.confidence === 'uncertain') &&
      ageSec <= SENSOR_CONSTANTS.transientTrackTtlSec
    ) {
      output.push(sanitizeTrack(record));
    } else {
      memory.delete(targetId);
    }
  }

  world.tracksByFaction[observerFaction] = output;
  return output;
}

export interface ResolvedFiringTrack {
  record: InternalTrackRecord;
  entity?: UnitEntity | MunitionEntity;
  aimPos: Vec2;
  aimVel: Vec2;
}

/**
 * Resolves a faction-local `trackId` for weapon firing (SW-15 / SW-16).
 * Rejects unknown tracks and bearing-only contacts (which lack range/position solutions).
 */
export function resolveTrackTargetForFiring(
  world: WorldState,
  faction: FactionId,
  trackId: string,
): { target?: ResolvedFiringTrack; error?: string } {
  const memory = world.trackMemoryByFaction[faction];
  for (const [key, record] of memory.entries()) {
    if (record.trackId !== trackId) {
      continue;
    }
    if (key.startsWith('ladar-warn-') || record.confidence === 'bearing' || !record.pos) {
      return {
        error: `Track ${trackId} is bearing-only and lacks a range solution for weapon lock`,
      };
    }
    const entity = world.units.get(record.targetId) ?? world.munitions.get(record.targetId);
    return {
      target: {
        record,
        entity,
        aimPos: { ...record.pos },
        aimVel: record.vel ? { ...record.vel } : { x: 0, y: 0 },
      },
    };
  }
  return { error: `Unknown or expired sensor track: ${trackId}` };
}

/**
 * Runs authoritative multi-channel sensing and fog-of-war filtering for both factions.
 */
export function stepSensorsAndFog(
  world: WorldState,
  irByUnit?: ReadonlyMap<string, number>,
): void {
  updateFactionSensors(world, 'earth', irByUnit);
  updateFactionSensors(world, 'mars', irByUnit);
}

/**
 * Helper used in tests and triangulation verification to derive an orbit estimate from
 * two observed positions separated by time.
 */
export function estimateOrbitFromStates(pos: Vec2, vel: Vec2, tSec: number): KeplerOrbit {
  return stateToOrbit(pos, vel, tSec);
}

/**
 * Creates a SimulationLoop system hook updating faction SensorTrack[] on every tick.
 */
export function createSensorTickSystem(irByUnit?: ReadonlyMap<string, number>): TickSystemHook {
  return ({ world }) => {
    stepSensorsAndFog(world, irByUnit);
  };
}
