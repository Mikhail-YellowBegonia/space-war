import {
  CELESTIAL_BODIES_BY_ID,
  WONDER_CONFIG,
  orbitToState,
  type CelestialBody,
  type FactionId,
  type KeplerOrbit,
  type Vec2,
  type WonderSlot,
} from '@space-war/shared';

export interface WonderSlotRenderNode {
  slot: WonderSlot;
  pos: Vec2;
  orbit: KeplerOrbit;
}

/**
 * Computes the 16 co-orbital wonder node positions for a faction at `gameTimeSec`.
 * Slots share the home planet's semi-major axis and eccentricity and revolve synchronously
 * around the Sun with the same angular rate, offset by half a slot pitch so slot 0 clears
 * the planet disc itself.
 */
export function computeCoOrbitalWonderNodes(
  faction: FactionId,
  wonderSlots: readonly WonderSlot[],
  gameTimeSec: number,
  bodiesById: Readonly<Record<string, CelestialBody>> = CELESTIAL_BODIES_BY_ID,
): WonderSlotRenderNode[] {
  const homeBody = bodiesById[faction];
  const baseOrbit: KeplerOrbit = homeBody?.orbit ?? {
    a: WONDER_CONFIG.ringSemiMajorAxisAu[faction],
    e: 0,
    omega: 0,
    meanAnomaly0: 0,
    epochSec: 0,
  };

  const count = Math.max(1, wonderSlots.length || WONDER_CONFIG.slotCount);
  const pitch = (2 * Math.PI) / count;
  const phaseOffset = pitch * 0.5;

  return wonderSlots.map((slot) => {
    const slotOrbit: KeplerOrbit = {
      ...baseOrbit,
      meanAnomaly0: baseOrbit.meanAnomaly0 + phaseOffset + slot.index * pitch,
    };
    const state = orbitToState(slotOrbit, gameTimeSec);
    return {
      slot,
      pos: state.pos,
      orbit: slotOrbit,
    };
  });
}
