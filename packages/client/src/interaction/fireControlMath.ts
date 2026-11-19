import {
  UNIT_CONFIGS,
  type FactionSnapshot,
  type SensorTrack,
  type UnitEntity,
  type Vec2,
} from '@space-war/shared';
import type { Camera2D } from '../camera/index.js';

export const ENGAGEMENT_THRESHOLDS = {
  /** Radius (AU) within which close-range gun/CIWS brawl advisories trigger. */
  closeRangeBrawlAu: 0.04,
  /** Radius (AU) within which incoming enemy munition tracks trigger interception alerts. */
  incomingMunitionAlertAu: 0.22,
} as const;

export type EngagementAdvisoryKind =
  | 'incoming_munition'
  | 'close_range_brawl'
  | 'laser_envelope';

export interface EngagementAdvisory {
  kind: EngagementAdvisoryKind;
  ownUnitId: string;
  trackId: string;
  distanceAu: number;
}

export interface ScreenBoxRect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Checks whether a sensor track has enough positional fidelity to accept BVR weapon fire.
 */
export function isTrackTargetableForFire(track: SensorTrack): boolean {
  return (
    (track.confidence === 'confirmed' || track.confidence === 'uncertain') &&
    track.pos !== undefined
  );
}

/**
 * Returns all targetable enemy tracks whose screen coordinates fall inside `box`.
 * If `onlyMunitions` is true, filters exclusively for `suspectedKind === 'munition'`.
 */
export function selectTracksInScreenBox(
  box: ScreenBoxRect,
  camera: Camera2D,
  snapshot: FactionSnapshot,
  onlyMunitions = false,
): SensorTrack[] {
  const minX = Math.min(box.x1, box.x2);
  const maxX = Math.max(box.x1, box.x2);
  const minY = Math.min(box.y1, box.y2);
  const maxY = Math.max(box.y1, box.y2);

  const selected: SensorTrack[] = [];
  for (const track of snapshot.tracks) {
    if (!isTrackTargetableForFire(track) || !track.pos) continue;
    if (onlyMunitions && track.suspectedKind !== 'munition') continue;

    const screen = camera.worldToScreen(track.pos);
    if (screen.x >= minX && screen.x <= maxX && screen.y >= minY && screen.y <= maxY) {
      selected.push(track);
    }
  }
  return selected;
}

/**
 * Picks the closest targetable enemy track near `screenPos`, prioritizing munition tracks
 * slightly when overlapping.
 */
export function pickTargetTrackAtScreenPos(
  screenPos: Vec2,
  camera: Camera2D,
  snapshot: FactionSnapshot,
  hitRadiusPx = 18,
): SensorTrack | null {
  let bestDist = hitRadiusPx;
  let best: SensorTrack | null = null;

  for (const track of snapshot.tracks) {
    if (!isTrackTargetableForFire(track) || !track.pos) continue;
    const p = camera.worldToScreen(track.pos);
    const d = Math.hypot(screenPos.x - p.x, screenPos.y - p.y);
    if (d <= bestDist) {
      bestDist = d;
      best = track;
    }
  }
  return best;
}

/**
 * Computes active laser range circles and close-range / incoming-munition engagement alerts
 * across all own units and visible enemy tracks.
 */
export function computeEngagementAdvisories(
  snapshot: FactionSnapshot,
): EngagementAdvisory[] {
  const advisories: EngagementAdvisory[] = [];

  for (const unit of snapshot.ownUnits) {
    if (unit.hp <= 0) continue;
    const laserRange = UNIT_CONFIGS[unit.kind].weapons.laserRangeAu;

    for (const track of snapshot.tracks) {
      if (!track.pos || track.confidence === 'bearing' || track.confidence === 'ghost') {
        continue;
      }
      const dist = Math.hypot(track.pos.x - unit.pos.x, track.pos.y - unit.pos.y);

      if (
        track.suspectedKind === 'munition' &&
        dist <= ENGAGEMENT_THRESHOLDS.incomingMunitionAlertAu
      ) {
        advisories.push({
          kind: 'incoming_munition',
          ownUnitId: unit.id,
          trackId: track.trackId,
          distanceAu: dist,
        });
      } else if (dist <= ENGAGEMENT_THRESHOLDS.closeRangeBrawlAu) {
        advisories.push({
          kind: 'close_range_brawl',
          ownUnitId: unit.id,
          trackId: track.trackId,
          distanceAu: dist,
        });
      } else if (laserRange > 0 && dist <= laserRange) {
        advisories.push({
          kind: 'laser_envelope',
          ownUnitId: unit.id,
          trackId: track.trackId,
          distanceAu: dist,
        });
      }
    }
  }

  return advisories;
}

export function canUnitFireWeapons(unit: UnitEntity | null): boolean {
  if (!unit) return false;
  return unit.hp > 0 && unit.ammoStock > 0 && unit.subsystems.weapons !== 'offline';
}
