import { SOLAR_GLARE_CONFIG } from '../config/index.js';
import type { KeplerOrbit, Vec2 } from '../types/index.js';
import { orbitToState } from './ephemeris.js';

export interface OccluderBody {
  id?: string;
  pos?: Vec2;
  orbit?: KeplerOrbit | null;
  occlusionRadiusAu: number;
  umbraLengthAu?: number;
}

function resolveBodyPos(body: OccluderBody, tSec: number): Vec2 {
  if (body.pos !== undefined) {
    return body.pos;
  }
  if (body.orbit != null) {
    return orbitToState(body.orbit, tSec).pos;
  }
  return { x: 0, y: 0 };
}

/**
 * Checks whether a position lies inside the anti-sunward solar umbra tangent cone of any body.
 * The Sun sits at the origin (0, 0). Accepts either CelestialBody[] (evaluated at tSec, default 0)
 * or pre-positioned body objects carrying `pos`.
 */
export function isInUmbra(
  pos: Vec2,
  bodies: readonly OccluderBody[],
  tSec = 0,
): boolean {
  for (const body of bodies) {
    const umbraLength = body.umbraLengthAu ?? 0;
    const radius = body.occlusionRadiusAu;
    if (body.id === 'sun' || umbraLength <= 0 || radius <= 0) {
      continue;
    }

    const bodyPos = resolveBodyPos(body, tSec);
    const distSq = bodyPos.x * bodyPos.x + bodyPos.y * bodyPos.y;
    const dist = Math.sqrt(distSq);
    if (dist <= radius) {
      continue;
    }

    const ux = bodyPos.x / dist;
    const uy = bodyPos.y / dist;

    // Projection of pos onto the Sun -> Body axis
    const proj = pos.x * ux + pos.y * uy;
    const projTangent = dist - (radius * radius) / dist;
    const antiSunDist = proj - dist;

    if (proj < projTangent || antiSunDist > umbraLength) {
      continue;
    }

    const perpX = pos.x - proj * ux;
    const perpY = pos.y - proj * uy;
    const perpSq = perpX * perpX + perpY * perpY;

    const tanAlpha = radius / Math.sqrt(distSq - radius * radius);
    const halfWidth = proj * tanAlpha;

    if (perpSq <= halfWidth * halfWidth + 1e-15) {
      return true;
    }
  }

  return false;
}

/**
 * Checks whether the line-of-sight segment between p1 and p2 pierces the occlusion disk
 * of any celestial body. Grazing tangents on the boundary do not self-occlude.
 */
export function isOccluded(
  p1: Vec2,
  p2: Vec2,
  bodies: readonly OccluderBody[],
  tSec = 0,
): boolean {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-18) {
    return false;
  }

  for (const body of bodies) {
    const radius = body.occlusionRadiusAu;
    if (radius <= 0) {
      continue;
    }

    const center = resolveBodyPos(body, tSec);
    const rawT = ((center.x - p1.x) * dx + (center.y - p1.y) * dy) / lenSq;
    const t = rawT < 0 ? 0 : rawT > 1 ? 1 : rawT;

    const closestX = p1.x + t * dx - center.x;
    const closestY = p1.y + t * dy - center.y;
    const distSq = closestX * closestX + closestY * closestY;

    if (distSq < radius * radius - 1e-15) {
      return true;
    }
  }

  return false;
}

/**
 * Computes the solar glare sensitivity multiplier in [minSensitivityFactor, 1].
 * Returns 1 when looking outside the sunward glare cone, and attenuates smoothly toward
 * minSensitivityFactor as the target aligns with the observer's line of sight to the Sun (0, 0).
 */
export function getSolarGlareFactor(observerPos: Vec2, targetPos: Vec2): number {
  const toSunX = -observerPos.x;
  const toSunY = -observerPos.y;
  const toSunLen = Math.hypot(toSunX, toSunY);

  const toTargetX = targetPos.x - observerPos.x;
  const toTargetY = targetPos.y - observerPos.y;
  const toTargetLen = Math.hypot(toTargetX, toTargetY);

  if (toSunLen <= 1e-12 || toTargetLen <= 1e-12) {
    return 1;
  }

  const cosTheta = Math.max(
    -1,
    Math.min(1, (toSunX * toTargetX + toSunY * toTargetY) / (toSunLen * toTargetLen)),
  );
  const theta = Math.acos(cosTheta);

  const { coneHalfAngleRad, minSensitivityFactor } = SOLAR_GLARE_CONFIG;
  if (theta >= coneHalfAngleRad) {
    return 1;
  }

  const u = theta / coneHalfAngleRad;
  const smooth = u * u * (3 - 2 * u);
  return minSensitivityFactor + (1 - minSensitivityFactor) * smooth;
}
