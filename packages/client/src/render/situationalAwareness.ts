import type { Vec2 } from '@space-war/shared';

export interface LineSegment2D {
  from: Vec2;
  to: Vec2;
}

export interface JamNoiseArcSpec {
  startAngle: number;
  endAngle: number;
  radiusScale: number;
}

/**
 * Computes a 4-vertex line-of-sight occlusion shadow sector behind `bodyPos` relative to
 * `observerPos`, matching the tangent cone where `isOccluded` blocks straight-line sensors.
 */
export function computeOcclusionSectorPolygon(
  observerPos: Vec2,
  bodyPos: Vec2,
  occlusionRadiusAu: number,
  extensionAu = 1.1,
): Vec2[] | null {
  if (occlusionRadiusAu <= 0 || extensionAu <= 0) {
    return null;
  }

  const dx = bodyPos.x - observerPos.x;
  const dy = bodyPos.y - observerPos.y;
  const distSq = dx * dx + dy * dy;
  const dist = Math.sqrt(distSq);
  if (dist <= occlusionRadiusAu + 1e-6) {
    return null;
  }

  const ux = dx / dist;
  const uy = dy / dist;
  const px = -uy;
  const py = ux;

  const projNear = dist - (occlusionRadiusAu * occlusionRadiusAu) / dist;
  const projFar = dist + extensionAu;
  const tanAlpha = occlusionRadiusAu / Math.sqrt(distSq - occlusionRadiusAu * occlusionRadiusAu);
  const halfNear = projNear * tanAlpha;
  const halfFar = projFar * tanAlpha;

  return [
    {
      x: observerPos.x + ux * projNear + px * halfNear,
      y: observerPos.y + uy * projNear + py * halfNear,
    },
    {
      x: observerPos.x + ux * projFar + px * halfFar,
      y: observerPos.y + uy * projFar + py * halfFar,
    },
    {
      x: observerPos.x + ux * projFar - px * halfFar,
      y: observerPos.y + uy * projFar - py * halfFar,
    },
    {
      x: observerPos.x + ux * projNear - px * halfNear,
      y: observerPos.y + uy * projNear - py * halfNear,
    },
  ];
}

/**
 * Samples world-space vertices for a rotated uncertainty error ellipse.
 */
export function sampleErrorEllipsePoints(
  center: Vec2,
  majorRadiusAu: number,
  minorRadiusAu: number,
  angleRad: number,
  segments = 36,
): Vec2[] {
  const a = Math.max(1e-6, majorRadiusAu);
  const b = Math.max(1e-6, minorRadiusAu);
  const cosA = Math.cos(angleRad);
  const sinA = Math.sin(angleRad);
  const count = Math.max(12, segments);
  const pts: Vec2[] = [];

  for (let i = 0; i <= count; i++) {
    const theta = (i / count) * 2 * Math.PI;
    const lx = a * Math.cos(theta);
    const ly = b * Math.sin(theta);
    pts.push({
      x: center.x + lx * cosA - ly * sinA,
      y: center.y + lx * sinA + ly * cosA,
    });
  }
  return pts;
}

/**
 * Computes diagonal hatch line segments clipped analytically inside a rotated ellipse
 * in world space (AU), avoiding any dependency on Canvas2D clip masks.
 */
export function computeEllipseHatchSegments(
  center: Vec2,
  majorRadiusAu: number,
  minorRadiusAu: number,
  angleRad: number,
  lineCount = 7,
): LineSegment2D[] {
  const a = Math.max(1e-6, majorRadiusAu);
  const b = Math.max(1e-6, minorRadiusAu);
  const cosA = Math.cos(angleRad);
  const sinA = Math.sin(angleRad);
  const segments: LineSegment2D[] = [];
  const count = Math.max(3, lineCount);

  // Diagonal hatch lines in ellipse-local space: x/a + y/b = c (or sloped lines y = x*(b/a) + offset)
  // Parameterize with slope m = b/a in local coords: (lx/a)^2 + (ly/b)^2 = 1
  // Normalized unit circle u = lx/a, v = ly/b: intersect u - v = d for d in (-sqrt(2), sqrt(2))
  const maxD = Math.SQRT2 * 0.86;
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : -maxD + (2 * maxD * i) / (count - 1);
    // Solve u^2 + (u - t)^2 = 1 -> 2u^2 - 2tu + (t^2 - 1) = 0
    const disc = 2 - t * t;
    if (disc <= 1e-6) continue;
    const sqrtDisc = Math.sqrt(disc);
    const u1 = (t - sqrtDisc) * 0.5;
    const u2 = (t + sqrtDisc) * 0.5;
    const v1 = u1 - t;
    const v2 = u2 - t;

    const lx1 = u1 * a;
    const ly1 = v1 * b;
    const lx2 = u2 * a;
    const ly2 = v2 * b;

    segments.push({
      from: {
        x: center.x + lx1 * cosA - ly1 * sinA,
        y: center.y + lx1 * sinA + ly1 * cosA,
      },
      to: {
        x: center.x + lx2 * cosA - ly2 * sinA,
        y: center.y + lx2 * sinA + ly2 * cosA,
      },
    });
  }

  return segments;
}

/**
 * Samples polygon vertices for a directional LADAR scan cone originating at `origin`.
 */
export function computeConeSectorPoints(
  origin: Vec2,
  centerAngleRad: number,
  coneWidthRad: number,
  rangeAu: number,
  arcSteps = 12,
): Vec2[] {
  const half = Math.max(0.01, coneWidthRad * 0.5);
  const steps = Math.max(4, arcSteps);
  const pts: Vec2[] = [{ x: origin.x, y: origin.y }];

  for (let i = 0; i <= steps; i++) {
    const a = centerAngleRad - half + (2 * half * i) / steps;
    pts.push({
      x: origin.x + Math.cos(a) * rangeAu,
      y: origin.y + Math.sin(a) * rangeAu,
    });
  }
  return pts;
}

/**
 * Generates deterministic static-noise arc segments for ECM-jammed tracks or active jammers.
 */
export function computeJamNoiseArcs(phaseTimeSec: number, arcCount = 6): JamNoiseArcSpec[] {
  const step = Math.floor(phaseTimeSec * 8);
  const arcs: JamNoiseArcSpec[] = [];

  for (let i = 0; i < arcCount; i++) {
    const hash = Math.sin((step + 1) * 12.9898 + (i + 1) * 78.233) * 43758.5453;
    const frac = hash - Math.floor(hash);
    const baseAngle = (i / arcCount) * Math.PI * 2 + frac * 0.7;
    const span = 0.28 + frac * 0.35;
    const radiusScale = 0.88 + (frac * 0.34);
    arcs.push({
      startAngle: baseAngle,
      endAngle: baseAngle + span,
      radiusScale,
    });
  }
  return arcs;
}

/**
 * Formats elapsed lost-contact time for `ghost` tracks.
 */
export function formatGhostLostTimer(lostSec: number): string {
  const sec = Math.max(0, Math.round(lostSec));
  if (sec < 60) {
    return `LOST ${sec}s`;
  }
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `LOST ${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
