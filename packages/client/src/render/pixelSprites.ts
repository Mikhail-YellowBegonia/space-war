import type { FactionId, MunitionProfileId, PropulsionType, UnitKind } from '@space-war/shared';

export interface PixelSpriteDefinition {
  width: number;
  height: number;
  /** Row strings where '.' = transparent, 'H' = hull, 'A' = accent/faction, 'R' = radiator, 'C' = cockpit/core. */
  rows: readonly string[];
}

export const UNIT_PIXEL_SPRITES: Readonly<Record<UnitKind, PixelSpriteDefinition>> = {
  home_base: {
    width: 11,
    height: 11,
    rows: [
      '...HHHHH...',
      '..H..A..H..',
      '.H.RR.RR.H.',
      'H..HAAAH..H',
      'H.RACCACRRH',
      'H.RACCACRRH',
      'H..HAAAH..H',
      '.H.RR.RR.H.',
      '..H..A..H..',
      '...HHHHH...',
      '...........',
    ],
  },
  mining_outpost: {
    width: 9,
    height: 9,
    rows: [
      '...HHH...',
      '..HAAAH..',
      '.R.HHH.R.',
      'HRHCCCHRH',
      '.R.HHH.R.',
      '..H...H..',
      '.HH...HH.',
      '.........',
      '.........',
    ],
  },
  relay_depot: {
    width: 9,
    height: 9,
    rows: [
      '....A....',
      '..HHHHH..',
      '.RHCCCHR.',
      'AAHHHHHAA',
      '.RHCCCHR.',
      '..HHHHH..',
      '....A....',
      '.........',
      '.........',
    ],
  },
  freighter: {
    width: 9,
    height: 7,
    rows: [
      '..RRRRR..',
      '.HHHHHHH.',
      'HHAAHAAHC',
      'HHHHHHHHH',
      'HHAAHAAHC',
      '.HHHHHHH.',
      '..RRRRR..',
    ],
  },
  tanker: {
    width: 9,
    height: 7,
    rows: [
      '..RRRR...',
      '.HHHHHHH.',
      'HAAAHAAHC',
      '.HHHHHHH.',
      'HAAAHAAHC',
      '.HHHHHHH.',
      '..RRRR...',
    ],
  },
  recon_corvette: {
    width: 9,
    height: 7,
    rows: [
      '..R......',
      '..RH.....',
      'HHHHHAA..',
      'HHCCCHHHA',
      'HHHHHAA..',
      '..RH.....',
      '..R......',
    ],
  },
  escort_frigate: {
    width: 11,
    height: 9,
    rows: [
      '...RR......',
      '..RHH......',
      '.HHHHHHA...',
      'HHHHCCCHHA.',
      'HHAAHHHHHHC',
      'HHHHCCCHHA.',
      '.HHHHHHA...',
      '..RHH......',
      '...RR......',
    ],
  },
  raider: {
    width: 11,
    height: 7,
    rows: [
      '..RRR......',
      '..HHHHH....',
      '.HHHHAAHH..',
      'HHHCCCHHHHA',
      '.HHHHAAHH..',
      '..HHHHH....',
      '..RRR......',
    ],
  },
  cruiser: {
    width: 13,
    height: 9,
    rows: [
      '..RRRR.......',
      '..RHHH.......',
      '.HHHHHHAAA...',
      'HHHHCCCHHHHA.',
      'HHHAAHHHHHHHC',
      'HHHHCCCHHHHA.',
      '.HHHHHHAAA...',
      '..RHHH.......',
      '..RRRR.......',
    ],
  },
  drone_recon: {
    width: 5,
    height: 5,
    rows: ['..R..', '.HHH.', 'HHCHA', '.HHH.', '..R..'],
  },
  drone_ew: {
    width: 5,
    height: 5,
    rows: ['.A.A.', 'HHHHH', '.ACA.', 'HHHHH', '.A.A.'],
  },
};

export const MUNITION_PIXEL_SPRITES: Readonly<Record<MunitionProfileId, PixelSpriteDefinition>> = {
  light_interceptor: {
    width: 5,
    height: 3,
    rows: ['.HH..', 'HHHHC', '.HH..'],
  },
  heavy_torpedo: {
    width: 7,
    height: 3,
    rows: ['.HHHH..', 'HHHHHHC', '.HHHH..'],
  },
};

export interface PixelSpritePalette {
  hull: string;
  accent: string;
  radiator: string;
  core: string;
}

/**
 * Computes radiator wing color shifting from cool stowed grey-teal -> warm amber -> incandescent red
 * based on radiator deployment and current heat-sink ratio.
 */
export function getRadiatorGlowColor(
  heatRatio: number,
  radiatorsOpen: boolean,
  emconSilent: boolean,
): string {
  if (!radiatorsOpen || emconSilent) {
    return '#2e414d';
  }
  const h = Math.max(0, Math.min(1, heatRatio));
  if (h >= 0.7) {
    return '#ff4d4f';
  }
  if (h >= 0.35) {
    return '#ff9f1c';
  }
  return '#4895ef';
}

/**
 * Returns faction-tinted hull/accent/core colors plus thermal-coupled radiator glow color.
 */
export function getUnitSpritePalette(
  faction: FactionId,
  heatRatio: number,
  radiatorsOpen: boolean,
  emconSilent: boolean,
): PixelSpritePalette {
  return {
    hull: faction === 'earth' ? '#7ab8c4' : '#c9886b',
    accent: faction === 'earth' ? '#5ce1e6' : '#ff8a4c',
    radiator: getRadiatorGlowColor(heatRatio, radiatorsOpen, emconSilent),
    core: emconSilent ? '#4a6475' : '#e6fcff',
  };
}

/**
 * Returns exhaust plume pixel color keyed to propulsion thermal signature.
 */
export function getPlumeColor(propulsion: PropulsionType, heatRatio: number): string {
  if (propulsion === 'nuclear') {
    return heatRatio > 0.6 ? '#fff2b2' : '#7df9ff';
  }
  if (propulsion === 'electric') {
    return '#5ce1e6';
  }
  return '#ffae42';
}
