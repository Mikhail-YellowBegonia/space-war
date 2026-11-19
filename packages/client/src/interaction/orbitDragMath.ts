import type {
  CelestialBody,
  FactionSnapshot,
  KeplerOrbit,
  SensorTrack,
  UnitEntity,
  Vec2,
} from '@space-war/shared';
import type { Camera2D } from '../camera/index.js';

export const ORBIT_DRAG_LIMITS = {
  minRadiusAu: 0.25,
  maxRadiusAu: 4.5,
  maxEccentricity: 0.85,
} as const;

export interface ApsisPositions {
  periapsis: Vec2;
  apoapsis: Vec2;
  rp: number;
  ra: number;
}

export type ApsisHandleKind = 'periapsis' | 'apoapsis';

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Computes world-space periapsis and apoapsis marker positions for a Keplerian orbit.
 */
export function getOrbitApsisPositions(orbit: KeplerOrbit): ApsisPositions {
  const e = clamp(orbit.e, 0, ORBIT_DRAG_LIMITS.maxEccentricity);
  const rp = orbit.a * (1 - e);
  const ra = orbit.a * (1 + e);
  const cosW = Math.cos(orbit.omega);
  const sinW = Math.sin(orbit.omega);

  return {
    periapsis: { x: rp * cosW, y: rp * sinW },
    apoapsis: { x: -ra * cosW, y: -ra * sinW },
    rp,
    ra,
  };
}

/**
 * Constructs a bounded Keplerian orbit from periapsis radius, apoapsis radius, and omega.
 */
export function buildOrbitFromApsides(
  r1: number,
  r2: number,
  omega: number,
  epochSec = 0,
): KeplerOrbit {
  const clamped1 = clamp(r1, ORBIT_DRAG_LIMITS.minRadiusAu, ORBIT_DRAG_LIMITS.maxRadiusAu);
  const clamped2 = clamp(r2, ORBIT_DRAG_LIMITS.minRadiusAu, ORBIT_DRAG_LIMITS.maxRadiusAu);
  const rp = Math.min(clamped1, clamped2);
  const ra = Math.max(clamped1, clamped2);
  const a = 0.5 * (rp + ra);
  const rawE = a > 1e-6 ? (ra - rp) / (ra + rp) : 0;
  const e = Math.min(ORBIT_DRAG_LIMITS.maxEccentricity, rawE);

  return {
    a,
    e,
    omega,
    meanAnomaly0: 0,
    epochSec,
  };
}

/**
 * Updates a draft target orbit when dragging either the periapsis or apoapsis handle.
 */
export function updateOrbitFromApsisHandleDrag(
  currentOrbit: KeplerOrbit,
  handle: ApsisHandleKind,
  cursorWorld: Vec2,
): KeplerOrbit {
  const currentApsides = getOrbitApsisPositions(currentOrbit);
  const fixedRadius = handle === 'periapsis' ? currentApsides.ra : currentApsides.rp;
  const cursorRadius = clamp(
    Math.hypot(cursorWorld.x, cursorWorld.y),
    ORBIT_DRAG_LIMITS.minRadiusAu,
    ORBIT_DRAG_LIMITS.maxRadiusAu,
  );
  const cursorAngle = Math.atan2(cursorWorld.y, cursorWorld.x);

  const cursorIsPeriapsis = cursorRadius <= fixedRadius;
  const omega = cursorIsPeriapsis ? cursorAngle : cursorAngle + Math.PI;
  return buildOrbitFromApsides(cursorRadius, fixedRadius, omega, currentOrbit.epochSec);
}

/**
 * Builds a target orbit directly from an anchor radius (e.g. unit position) and a dragged
 * cursor position on the star map.
 */
export function buildOrbitFromTwoPointDrag(anchorWorld: Vec2, dragWorld: Vec2): KeplerOrbit {
  const rAnchor = clamp(
    Math.hypot(anchorWorld.x, anchorWorld.y),
    ORBIT_DRAG_LIMITS.minRadiusAu,
    ORBIT_DRAG_LIMITS.maxRadiusAu,
  );
  const rDrag = clamp(
    Math.hypot(dragWorld.x, dragWorld.y),
    ORBIT_DRAG_LIMITS.minRadiusAu,
    ORBIT_DRAG_LIMITS.maxRadiusAu,
  );
  const dragAngle = Math.atan2(dragWorld.y, dragWorld.x);
  const omega = rDrag <= rAnchor ? dragAngle : dragAngle + Math.PI;
  return buildOrbitFromApsides(rAnchor, rDrag, omega, 0);
}

/**
 * Picks either the periapsis or apoapsis handle if the screen cursor is within `hitRadiusPx`.
 */
export function pickApsisHandleAtScreenPos(
  screenPos: Vec2,
  camera: Camera2D,
  orbit: KeplerOrbit,
  hitRadiusPx = 16,
): ApsisHandleKind | null {
  const apsides = getOrbitApsisPositions(orbit);
  const pScreen = camera.worldToScreen(apsides.periapsis);
  const aScreen = camera.worldToScreen(apsides.apoapsis);

  const distP = Math.hypot(screenPos.x - pScreen.x, screenPos.y - pScreen.y);
  const distA = Math.hypot(screenPos.x - aScreen.x, screenPos.y - aScreen.y);

  if (distP <= hitRadiusPx && distP <= distA) {
    return 'periapsis';
  }
  if (distA <= hitRadiusPx) {
    return 'apoapsis';
  }
  return null;
}

export type PickedMapEntity =
  | { kind: 'unit'; unit: UnitEntity }
  | { kind: 'track'; track: SensorTrack }
  | { kind: 'body'; body: CelestialBody };

/**
 * Picks the closest interactive unit, sensor track, or orbiting celestial body under `screenPos`.
 */
export function pickEntityAtScreenPos(
  screenPos: Vec2,
  camera: Camera2D,
  snapshot: FactionSnapshot,
  bodies: readonly CelestialBody[],
  hitRadiusPx = 18,
): PickedMapEntity | null {
  let bestDist = hitRadiusPx;
  let best: PickedMapEntity | null = null;

  for (const unit of snapshot.ownUnits) {
    const p = camera.worldToScreen(unit.pos);
    const d = Math.hypot(screenPos.x - p.x, screenPos.y - p.y);
    if (d <= bestDist) {
      bestDist = d;
      best = { kind: 'unit', unit };
    }
  }
  if (best) {
    return best;
  }

  for (const track of snapshot.tracks) {
    if (!track.pos) continue;
    const p = camera.worldToScreen(track.pos);
    const d = Math.hypot(screenPos.x - p.x, screenPos.y - p.y);
    if (d <= bestDist) {
      bestDist = d;
      best = { kind: 'track', track };
    }
  }

  const bodyById = new Map(bodies.map((b) => [b.id, b]));
  for (const cel of snapshot.celestials) {
    if (cel.id === 'sun') continue;
    const body = bodyById.get(cel.id);
    if (!body || !body.orbit) continue;
    const p = camera.worldToScreen(cel.pos);
    const bodyPx = Math.max(8, body.visualRadiusAu * camera.getPixelsPerAu());
    const effectiveRadius = Math.max(hitRadiusPx, bodyPx + 4);
    const d = Math.hypot(screenPos.x - p.x, screenPos.y - p.y);
    if (d <= effectiveRadius && d < bestDist) {
      bestDist = d;
      best = { kind: 'body', body };
    }
  }

  return best;
}
