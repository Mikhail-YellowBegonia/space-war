import { PROTOCOL_VERSION, SIM_TICK_RATE_HZ } from '@space-war/shared';

/**
 * Formats the CIC boot banner displayed on the client shell.
 */
export function getClientBootBanner(): string {
  return `SPACE WAR CIC // PROTOCOL v${PROTOCOL_VERSION} // ${SIM_TICK_RATE_HZ}Hz`;
}
