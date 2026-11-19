import type { KeplerOrbit, Vec2 } from '@space-war/shared';

/**
 * Samples world-space points along a Keplerian orbit ellipse in counter-clockwise order.
 * Returns `segments + 1` points (closing back to the starting point).
 */
export function sampleOrbitPoints(orbit: KeplerOrbit, segments = 192): Vec2[] {
  const count = Math.max(16, segments);
  const e = Math.max(0, Math.min(0.92, orbit.e));
  const semiLatusRectum = orbit.a * (1 - e * e);
  const cosW = Math.cos(orbit.omega);
  const sinW = Math.sin(orbit.omega);

  const points: Vec2[] = [];
  for (let i = 0; i <= count; i++) {
    const nu = (i / count) * 2 * Math.PI;
    const r = semiLatusRectum / (1 + e * Math.cos(nu));
    const xOrb = r * Math.cos(nu);
    const yOrb = r * Math.sin(nu);
    points.push({
      x: xOrb * cosW - yOrb * sinW,
      y: xOrb * sinW + yOrb * cosW,
    });
  }
  return points;
}

/**
 * Clips a 2D line segment to an axis-aligned rectangle using Liang-Barsky clipping.
 * Prevents Canvas2D from receiving huge off-screen coordinates at tight tactical zoom levels.
 */
export function clipSegmentToRect(
  p1: Vec2,
  p2: Vec2,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): [Vec2, Vec2] | null {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;

  let t0 = 0;
  let t1 = 1;

  const checks: ReadonlyArray<[number, number]> = [
    [-dx, p1.x - minX],
    [dx, maxX - p1.x],
    [-dy, p1.y - minY],
    [dy, maxY - p1.y],
  ];

  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) {
        return null;
      }
      continue;
    }
    const ratio = q / p;
    if (p < 0) {
      if (ratio > t1) {
        return null;
      }
      if (ratio > t0) {
        t0 = ratio;
      }
    } else {
      if (ratio < t0) {
        return null;
      }
      if (ratio < t1) {
        t1 = ratio;
      }
    }
  }

  return [
    { x: p1.x + t0 * dx, y: p1.y + t0 * dy },
    { x: p1.x + t1 * dx, y: p1.y + t1 * dy },
  ];
}

/**
 * Computes the 4-vertex anti-sunward tangent-cone umbra polygon in world coordinates (AU),
 * matching the shared `isInUmbra` geometry.
 */
export function computeUmbraSectorPolygon(
  bodyPos: Vec2,
  occlusionRadiusAu: number,
  umbraLengthAu: number,
): Vec2[] | null {
  if (occlusionRadiusAu <= 0 || umbraLengthAu <= 0) {
    return null;
  }

  const distSq = bodyPos.x * bodyPos.x + bodyPos.y * bodyPos.y;
  const dist = Math.sqrt(distSq);
  if (dist <= occlusionRadiusAu) {
    return null;
  }

  const ux = bodyPos.x / dist;
  const uy = bodyPos.y / dist;
  const px = -uy;
  const py = ux;

  const projNear = dist - (occlusionRadiusAu * occlusionRadiusAu) / dist;
  const projFar = dist + umbraLengthAu;
  const tanAlpha = occlusionRadiusAu / Math.sqrt(distSq - occlusionRadiusAu * occlusionRadiusAu);
  const halfWidthNear = projNear * tanAlpha;
  const halfWidthFar = projFar * tanAlpha;

  return [
    { x: ux * projNear + px * halfWidthNear, y: uy * projNear + py * halfWidthNear },
    { x: ux * projFar + px * halfWidthFar, y: uy * projFar + py * halfWidthFar },
    { x: ux * projFar - px * halfWidthFar, y: uy * projFar - py * halfWidthFar },
    { x: ux * projNear - px * halfWidthNear, y: uy * projNear - py * halfWidthNear },
  ];
}

export interface ScaleBarSpec {
  au: number;
  label: string;
  pixels: number;
}

const SCALE_BAR_CANDIDATES_AU = [5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01, 0.005];

/**
 * Selects a clean AU scale bar length that spans roughly 75-160 screen pixels.
 */
export function computeScaleBarSpec(pixelsPerAu: number, targetPx = 110): ScaleBarSpec {
  let best = SCALE_BAR_CANDIDATES_AU[SCALE_BAR_CANDIDATES_AU.length - 1];
  let bestDiff = Infinity;

  for (const au of SCALE_BAR_CANDIDATES_AU) {
    const px = au * pixelsPerAu;
    const diff = Math.abs(px - targetPx);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = au;
    }
  }

  return {
    au: best,
    label: best >= 1 ? `${best.toFixed(0)} AU` : `${best} AU`,
    pixels: best * pixelsPerAu,
  };
}
