import {
  LOGISTICS_CONFIG,
  UNIT_CONFIGS,
  WONDER_CONFIG,
  type BuildQueueKind,
  type FactionSnapshot,
  type LogisticsRoute,
  type TransferMode,
  type UnitEntity,
  type UnitKind,
  type Vec2,
} from '@space-war/shared';
import type { CommandAck, IWorldProvider } from '../net/index.js';

export interface BuildCatalogItem {
  kind: BuildQueueKind;
  label: string;
  costOre: number;
  costPropellant: number;
  buildTimeSec: number;
}

export const BUILDABLE_SHIP_KINDS: readonly UnitKind[] = [
  'recon_corvette',
  'escort_frigate',
  'raider',
  'cruiser',
  'tanker',
];

export function getBuildCatalog(): BuildCatalogItem[] {
  const items: BuildCatalogItem[] = BUILDABLE_SHIP_KINDS.map((kind) => {
    const cfg = UNIT_CONFIGS[kind];
    return {
      kind,
      label: cfg.name,
      costOre: cfg.costOre,
      costPropellant: cfg.costPropellant,
      buildTimeSec: cfg.buildTimeSec,
    };
  });

  items.push(
    {
      kind: 'freighter_cap',
      label: 'Freighter Capacity +1',
      costOre: LOGISTICS_CONFIG.freighterCapCostOre,
      costPropellant: 0,
      buildTimeSec: LOGISTICS_CONFIG.freighterCapBuildTimeSec,
    },
    {
      kind: 'outpost',
      label: UNIT_CONFIGS.mining_outpost.name,
      costOre: UNIT_CONFIGS.mining_outpost.costOre,
      costPropellant: UNIT_CONFIGS.mining_outpost.costPropellant,
      buildTimeSec: UNIT_CONFIGS.mining_outpost.buildTimeSec,
    },
    {
      kind: 'relay_depot',
      label: UNIT_CONFIGS.relay_depot.name,
      costOre: UNIT_CONFIGS.relay_depot.costOre,
      costPropellant: UNIT_CONFIGS.relay_depot.costPropellant,
      buildTimeSec: UNIT_CONFIGS.relay_depot.buildTimeSec,
    },
    {
      kind: 'wonder_slot',
      label: 'Wonder Ring Segment',
      costOre: WONDER_CONFIG.orePerSlot,
      costPropellant: 0,
      buildTimeSec: WONDER_CONFIG.buildTimePerSlotSec,
    },
  );

  return items;
}

export interface LogisticsUiState {
  pendingDetourRouteId: string | null;
  pendingRelayPlacement: boolean;
  lastMessage: string | null;
}

export type LogisticsUiListener = (state: LogisticsUiState) => void;

/**
 * Manages logistics route controls (pause, batch size, mode, detour waypoint, escort binding)
 * and home-base build/wonder queue commands.
 */
export class LogisticsBuildController {
  private provider: IWorldProvider;
  private pendingDetourRouteId: string | null = null;
  private pendingRelayPlacement = false;
  private lastMessage: string | null = null;
  private readonly listeners = new Set<LogisticsUiListener>();

  constructor(provider: IWorldProvider) {
    this.provider = provider;
  }

  setProvider(provider: IWorldProvider): void {
    this.provider = provider;
    this.pendingDetourRouteId = null;
    this.pendingRelayPlacement = false;
    this.lastMessage = null;
    this.emit();
  }

  subscribe(listener: LogisticsUiListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.listeners.clear();
  }

  getState(): LogisticsUiState {
    return {
      pendingDetourRouteId: this.pendingDetourRouteId,
      pendingRelayPlacement: this.pendingRelayPlacement,
      lastMessage: this.lastMessage,
    };
  }

  private findRoute(routeId: string): LogisticsRoute | null {
    return this.provider.getSnapshot().routes.find((r) => r.id === routeId) ?? null;
  }

  toggleRoutePaused(routeId: string): Promise<CommandAck> {
    const route = this.findRoute(routeId);
    if (!route) return Promise.resolve({ accepted: false, reason: '未知航线' });
    return this.provider.sendCommand({
      type: 'update_route',
      routeId,
      patch: { paused: !route.paused },
    });
  }

  cycleBatchSize(routeId: string): Promise<CommandAck> {
    const route = this.findRoute(routeId);
    if (!route) return Promise.resolve({ accepted: false, reason: '未知航线' });
    const nextBatch = route.batchSize >= 3 ? 1 : route.batchSize + 1;
    return this.provider.sendCommand({
      type: 'update_route',
      routeId,
      patch: { batchSize: nextBatch },
    });
  }

  setTransferMode(routeId: string, transferMode: TransferMode): Promise<CommandAck> {
    const route = this.findRoute(routeId);
    if (!route) return Promise.resolve({ accepted: false, reason: '未知航线' });
    return this.provider.sendCommand({
      type: 'update_route',
      routeId,
      patch: { transferMode },
    });
  }

  beginDetourPlacement(routeId: string): void {
    this.pendingDetourRouteId = routeId;
    this.pendingRelayPlacement = false;
    this.lastMessage = `请在星图上点击或拖拽设置 ${routeId} 深空绕路航点`;
    this.emit();
  }

  cancelDetourPlacement(): void {
    this.pendingDetourRouteId = null;
    this.emit();
  }

  async setDetourWaypoint(routeId: string, waypoint: Vec2): Promise<CommandAck> {
    const ack = await this.provider.sendCommand({
      type: 'update_route',
      routeId,
      patch: { detourWaypoint: { x: waypoint.x, y: waypoint.y } },
    });
    this.pendingDetourRouteId = null;
    this.lastMessage = ack.accepted
      ? `${routeId} 绕路航点已设定 (${waypoint.x.toFixed(2)}, ${waypoint.y.toFixed(2)})`
      : (ack.reason ?? '绕路设置失败');
    this.emit();
    return ack;
  }

  async clearDetourWaypoint(routeId: string): Promise<CommandAck> {
    const ack = await this.provider.sendCommand({
      type: 'update_route',
      routeId,
      patch: { detourWaypoint: undefined },
    });
    this.lastMessage = ack.accepted ? `${routeId} 已清除绕路航点` : (ack.reason ?? '操作失败');
    this.emit();
    return ack;
  }

  async toggleEscortBinding(routeId: string, unitId: string): Promise<CommandAck> {
    const route = this.findRoute(routeId);
    if (!route) return { accepted: false, reason: '未知航线' };
    const exists = route.escortUnitIds.includes(unitId);
    const nextEscorts = exists
      ? route.escortUnitIds.filter((id) => id !== unitId)
      : [...route.escortUnitIds, unitId];
    const ack = await this.provider.sendCommand({
      type: 'update_route',
      routeId,
      patch: { escortUnitIds: nextEscorts },
    });
    this.lastMessage = ack.accepted
      ? `${routeId} 护航编组: ${nextEscorts.length > 0 ? nextEscorts.join(', ') : '无'}`
      : (ack.reason ?? '护航绑定失败');
    this.emit();
    return ack;
  }

  beginRelayPlacement(): void {
    this.pendingRelayPlacement = true;
    this.pendingDetourRouteId = null;
    this.lastMessage = '请在星图上点击位置部署深空轨道中继站';
    this.emit();
  }

  async placeRelayDepotAt(worldPos: Vec2): Promise<CommandAck> {
    this.pendingRelayPlacement = false;
    const ack = await this.provider.sendCommand({
      type: 'queue_build',
      kind: 'relay_depot',
      targetRef: { x: worldPos.x, y: worldPos.y },
    });
    this.lastMessage = ack.accepted
      ? `已下达中继站建造指令 (${worldPos.x.toFixed(2)}, ${worldPos.y.toFixed(2)})`
      : (ack.reason ?? '中继站建造失败');
    this.emit();
    return ack;
  }

  async queueBuild(kind: BuildQueueKind, targetRef?: string | Vec2): Promise<CommandAck> {
    const ack = await this.provider.sendCommand({
      type: 'queue_build',
      kind,
      ...(targetRef !== undefined ? { targetRef } : {}),
    });
    this.lastMessage = ack.accepted
      ? `已加入建造指令: ${kind}`
      : (ack.reason ?? `建造指令失败: ${kind}`);
    this.emit();
    return ack;
  }

  static getEscortCandidates(snapshot: FactionSnapshot): UnitEntity[] {
    return snapshot.ownUnits.filter(
      (u) =>
        u.hp > 0 &&
        (u.kind === 'escort_frigate' || u.kind === 'raider' || u.kind === 'cruiser'),
    );
  }

  private emit(): void {
    const state = this.getState();
    for (const fn of this.listeners) {
      fn(state);
    }
  }
}
