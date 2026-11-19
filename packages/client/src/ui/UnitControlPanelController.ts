import {
  SOLAR_SYSTEM_BODIES,
  UNIT_CONFIGS,
  isInUmbra,
  type FactionSnapshot,
  type UnitEntity,
} from '@space-war/shared';
import type { CommandAck, IWorldProvider } from '../net/index.js';

export type HeatSinkLevel = 'nominal' | 'warm' | 'critical';

export interface UnitControlViewModel {
  unit: UnitEntity;
  heatPercent: number;
  heatLevel: HeatSinkLevel;
  inUmbra: boolean;
  ladarSupported: boolean;
  ladarEnabled: boolean;
  ladarAngleDeg: number;
  droneCapacity: number;
}

function wrapDegrees360(deg: number): number {
  const mod = deg % 360;
  return mod < 0 ? mod + 360 : mod;
}

export function radToDeg360(rad: number): number {
  return wrapDegrees360((rad * 180) / Math.PI);
}

export function degToRad(deg: number): number {
  return (wrapDegrees360(deg) * Math.PI) / 180;
}

/**
 * Derives the unit tactical control view model from the latest snapshot.
 */
export function buildUnitControlViewModel(
  snapshot: FactionSnapshot,
  unitId: string | null,
): UnitControlViewModel | null {
  if (!unitId) return null;
  const unit = snapshot.ownUnits.find((u) => u.id === unitId);
  if (!unit) return null;

  const cfg = UNIT_CONFIGS[unit.kind];
  const heatRatio = unit.maxHeat > 0 ? Math.max(0, Math.min(1, unit.heat / unit.maxHeat)) : 0;
  const heatPercent = Math.round(heatRatio * 100);
  const heatLevel: HeatSinkLevel =
    heatPercent >= 85 ? 'critical' : heatPercent >= 60 ? 'warm' : 'nominal';

  const ladarSupported = cfg.sensors.ladarRangeAu > 0;
  const ladarEnabled = ladarSupported && unit.ladarTargetAngle !== undefined;
  const ladarAngleDeg =
    unit.ladarTargetAngle !== undefined ? Math.round(radToDeg360(unit.ladarTargetAngle)) : 0;

  return {
    unit,
    heatPercent,
    heatLevel,
    inUmbra: isInUmbra(unit.pos, SOLAR_SYSTEM_BODIES, snapshot.gameTimeSec),
    ladarSupported,
    ladarEnabled,
    ladarAngleDeg,
    droneCapacity: cfg.weapons.droneCapacity,
  };
}

/**
 * Controller translating single-unit terminal interactions (EMCON, radiators, radar,
 * RF jammer, LADAR sector rotation, and drone launches) into `PlayerCommand` dispatches.
 */
export class UnitControlPanelController {
  private provider: IWorldProvider;

  constructor(provider: IWorldProvider) {
    this.provider = provider;
  }

  setProvider(provider: IWorldProvider): void {
    this.provider = provider;
  }

  getViewModel(unitId: string | null): UnitControlViewModel | null {
    return buildUnitControlViewModel(this.provider.getSnapshot(), unitId);
  }

  toggleEmconSilent(unitId: string): Promise<CommandAck> {
    const vm = this.getViewModel(unitId);
    if (!vm) {
      return Promise.resolve({ accepted: false, reason: '未选中己方单位' });
    }
    const nextSilent = !vm.unit.emconSilent;
    return this.provider.sendCommand({
      type: 'set_emcon',
      unitId,
      silent: nextSilent,
      radiatorsOpen: nextSilent ? false : true,
      radarActive: false,
      jammerActive: false,
    });
  }

  toggleRadiators(unitId: string): Promise<CommandAck> {
    const vm = this.getViewModel(unitId);
    if (!vm) {
      return Promise.resolve({ accepted: false, reason: '未选中己方单位' });
    }
    const nextRadiators = !vm.unit.radiatorsOpen;
    return this.provider.sendCommand({
      type: 'set_emcon',
      unitId,
      silent: false,
      radiatorsOpen: nextRadiators,
      radarActive: vm.unit.radarActive,
      jammerActive: vm.unit.jammerActive,
    });
  }

  toggleRadar(unitId: string): Promise<CommandAck> {
    const vm = this.getViewModel(unitId);
    if (!vm) {
      return Promise.resolve({ accepted: false, reason: '未选中己方单位' });
    }
    const nextRadar = !vm.unit.radarActive;
    return this.provider.sendCommand({
      type: 'set_emcon',
      unitId,
      silent: nextRadar ? false : vm.unit.emconSilent,
      radiatorsOpen: nextRadar && vm.unit.emconSilent ? true : vm.unit.radiatorsOpen,
      radarActive: nextRadar,
      jammerActive: vm.unit.jammerActive,
    });
  }

  toggleJammer(unitId: string): Promise<CommandAck> {
    const vm = this.getViewModel(unitId);
    if (!vm) {
      return Promise.resolve({ accepted: false, reason: '未选中己方单位' });
    }
    const nextJammer = !vm.unit.jammerActive;
    return this.provider.sendCommand({
      type: 'set_emcon',
      unitId,
      silent: nextJammer ? false : vm.unit.emconSilent,
      radiatorsOpen: nextJammer && vm.unit.emconSilent ? true : vm.unit.radiatorsOpen,
      radarActive: vm.unit.radarActive,
      jammerActive: nextJammer,
    });
  }

  toggleLadar(unitId: string): Promise<CommandAck> {
    const vm = this.getViewModel(unitId);
    if (!vm) {
      return Promise.resolve({ accepted: false, reason: '未选中己方单位' });
    }
    if (!vm.ladarSupported) {
      return Promise.resolve({ accepted: false, reason: '该单位未配备 LADAR' });
    }
    return this.provider.sendCommand({
      type: 'set_ladar',
      unitId,
      angleRad: vm.ladarEnabled ? null : 0,
    });
  }

  setLadarAngleDeg(unitId: string, angleDeg: number | null): Promise<CommandAck> {
    const vm = this.getViewModel(unitId);
    if (!vm) {
      return Promise.resolve({ accepted: false, reason: '未选中己方单位' });
    }
    if (!vm.ladarSupported) {
      return Promise.resolve({ accepted: false, reason: '该单位未配备 LADAR' });
    }
    return this.provider.sendCommand({
      type: 'set_ladar',
      unitId,
      angleRad: angleDeg === null ? null : degToRad(angleDeg),
    });
  }

  rotateLadarByDeg(unitId: string, deltaDeg: number): Promise<CommandAck> {
    const vm = this.getViewModel(unitId);
    if (!vm) {
      return Promise.resolve({ accepted: false, reason: '未选中己方单位' });
    }
    const baseDeg = vm.ladarEnabled ? vm.ladarAngleDeg : 0;
    return this.setLadarAngleDeg(unitId, wrapDegrees360(baseDeg + deltaDeg));
  }

  launchDrone(unitId: string, droneKind: 'drone_recon' | 'drone_ew'): Promise<CommandAck> {
    const vm = this.getViewModel(unitId);
    if (!vm) {
      return Promise.resolve({ accepted: false, reason: '未选中己方单位' });
    }
    if (vm.droneCapacity <= 0) {
      return Promise.resolve({ accepted: false, reason: '该单位无无人机舱' });
    }
    return this.provider.sendCommand({
      type: 'launch_drone',
      unitId,
      droneKind,
    });
  }
}
