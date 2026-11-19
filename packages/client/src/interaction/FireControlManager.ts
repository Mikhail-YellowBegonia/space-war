import {
  MUNITION_CONFIGS,
  type FactionSnapshot,
  type MunitionProfileId,
  type SensorTrack,
  type UnitEntity,
  type Vec2,
} from '@space-war/shared';
import type { Camera2D } from '../camera/index.js';
import type { CommandAck, IWorldProvider } from '../net/index.js';
import {
  canUnitFireWeapons,
  computeEngagementAdvisories,
  pickTargetTrackAtScreenPos,
  selectTracksInScreenBox,
  type EngagementAdvisory,
  type ScreenBoxRect,
} from './fireControlMath.js';

export interface FireControlState {
  profileId: MunitionProfileId;
  salvoCount: number;
  coldCoast: boolean;
  selectedTargetTrackIds: string[];
  boxSelectRect: ScreenBoxRect | null;
  advisories: EngagementAdvisory[];
  lastFireMessage: string | null;
}

export type FireControlListener = (state: FireControlState) => void;

/**
 * Manages BVR salvo configuration, track target selection, box-selection of incoming
 * enemy munition tracks for interception, and close-range engagement advisories.
 */
export class FireControlManager {
  private provider: IWorldProvider;
  private snapshot: FactionSnapshot;
  private unsubProvider: () => void;
  private readonly listeners = new Set<FireControlListener>();

  private profileId: MunitionProfileId = 'heavy_torpedo';
  private salvoCount = 2;
  private coldCoast = true;
  private selectedTargetTrackIds: string[] = [];
  private boxSelectRect: ScreenBoxRect | null = null;
  private boxDragOrigin: Vec2 | null = null;
  private advisories: EngagementAdvisory[] = [];
  private lastFireMessage: string | null = null;

  constructor(provider: IWorldProvider) {
    this.provider = provider;
    this.snapshot = provider.getSnapshot();
    this.advisories = computeEngagementAdvisories(this.snapshot);

    this.unsubProvider = this.provider.subscribe((snap) => {
      this.handleSnapshot(snap);
    });
  }

  setProvider(provider: IWorldProvider): void {
    this.unsubProvider();
    this.provider = provider;
    this.selectedTargetTrackIds = [];
    this.boxSelectRect = null;
    this.boxDragOrigin = null;
    this.lastFireMessage = null;
    this.snapshot = provider.getSnapshot();
    this.advisories = computeEngagementAdvisories(this.snapshot);
    this.unsubProvider = this.provider.subscribe((snap) => {
      this.handleSnapshot(snap);
    });
    this.emitState();
  }

  dispose(): void {
    this.unsubProvider();
    this.listeners.clear();
  }

  subscribe(listener: FireControlListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState(): FireControlState {
    return {
      profileId: this.profileId,
      salvoCount: this.salvoCount,
      coldCoast: MUNITION_CONFIGS[this.profileId].canColdCoast ? this.coldCoast : false,
      selectedTargetTrackIds: [...this.selectedTargetTrackIds],
      boxSelectRect: this.boxSelectRect ? { ...this.boxSelectRect } : null,
      advisories: [...this.advisories],
      lastFireMessage: this.lastFireMessage,
    };
  }

  setProfileId(profileId: MunitionProfileId): void {
    this.profileId = profileId;
    if (!MUNITION_CONFIGS[profileId].canColdCoast) {
      this.coldCoast = false;
    }
    this.emitState();
  }

  setSalvoCount(count: number): void {
    const clamped = Math.max(1, Math.min(8, Math.round(count)));
    this.salvoCount = clamped;
    this.emitState();
  }

  setColdCoast(enabled: boolean): void {
    if (!MUNITION_CONFIGS[this.profileId].canColdCoast) {
      this.coldCoast = false;
    } else {
      this.coldCoast = enabled;
    }
    this.emitState();
  }

  selectTargetTrack(trackId: string): void {
    this.selectedTargetTrackIds = [trackId];
    this.lastFireMessage = null;
    this.emitState();
  }

  clearTargetSelection(): void {
    this.selectedTargetTrackIds = [];
    this.emitState();
  }

  /**
   * Starts a box-selection drag or single-click target selection in fire-control mode.
   */
  beginTargetBoxOrPick(screenPos: Vec2): void {
    this.boxDragOrigin = { ...screenPos };
    this.boxSelectRect = {
      x1: screenPos.x,
      y1: screenPos.y,
      x2: screenPos.x,
      y2: screenPos.y,
    };
    this.emitState();
  }

  updateTargetBoxDrag(screenPos: Vec2): void {
    if (!this.boxDragOrigin) return;
    this.boxSelectRect = {
      x1: this.boxDragOrigin.x,
      y1: this.boxDragOrigin.y,
      x2: screenPos.x,
      y2: screenPos.y,
    };
    this.emitState();
  }

  endTargetBoxOrPick(screenPos: Vec2, camera: Camera2D): SensorTrack[] {
    const rect = this.boxSelectRect;
    this.boxDragOrigin = null;
    this.boxSelectRect = null;

    if (!rect) {
      return [];
    }

    const dragDist = Math.hypot(rect.x2 - rect.x1, rect.y2 - rect.y1);
    if (dragDist >= 10) {
      // Box selection: prefer incoming munition tracks if any exist inside box, else all targetable tracks
      const munitionsInBox = selectTracksInScreenBox(rect, camera, this.snapshot, true);
      const picked =
        munitionsInBox.length > 0
          ? munitionsInBox
          : selectTracksInScreenBox(rect, camera, this.snapshot, false);

      this.selectedTargetTrackIds = picked.map((t) => t.trackId);
      if (munitionsInBox.length > 0) {
        this.profileId = 'light_interceptor';
        this.coldCoast = false;
        this.lastFireMessage = `已框选 ${munitionsInBox.length} 枚来袭弹药航迹，已切换轻型拦截弹`;
      } else if (picked.length > 0) {
        this.lastFireMessage = `已框选 ${picked.length} 个可打击航迹`;
      }
      this.emitState();
      return picked;
    }

    const single = pickTargetTrackAtScreenPos(screenPos, camera, this.snapshot);
    if (single) {
      this.selectedTargetTrackIds = [single.trackId];
      if (single.suspectedKind === 'munition') {
        this.profileId = 'light_interceptor';
        this.coldCoast = false;
      }
      this.lastFireMessage = `火控锁定目标: ${single.trackId}`;
      this.emitState();
      return [single];
    }

    this.emitState();
    return [];
  }

  /**
   * Fires the configured salvo from `shooter` against each selected target track
   * (or explicit `overrideTrackIds`).
   */
  async fireAtSelectedTargets(
    shooter: UnitEntity | null,
    overrideTrackIds?: readonly string[],
  ): Promise<CommandAck> {
    if (!shooter) {
      this.lastFireMessage = '请先选择己方发射舰船';
      this.emitState();
      return { accepted: false, reason: this.lastFireMessage };
    }
    if (!canUnitFireWeapons(shooter)) {
      this.lastFireMessage =
        shooter.subsystems.weapons === 'offline'
          ? '武器子系统瘫痪'
          : `${shooter.id} 弹药库已空或无法开火`;
      this.emitState();
      return { accepted: false, reason: this.lastFireMessage };
    }

    const targets = overrideTrackIds ? [...overrideTrackIds] : [...this.selectedTargetTrackIds];
    if (targets.length === 0) {
      this.lastFireMessage = '请先选中 Confirmed 或 Uncertain 航迹目标';
      this.emitState();
      return { accepted: false, reason: this.lastFireMessage };
    }

    const allowColdCoast = MUNITION_CONFIGS[this.profileId].canColdCoast ? this.coldCoast : false;
    let remainingAmmo = shooter.ammoStock;
    let totalDispatched = 0;
    let lastReason: string | undefined;

    for (const trackId of targets) {
      if (remainingAmmo <= 0) break;
      const count = Math.min(this.salvoCount, remainingAmmo);
      const ack = await this.provider.sendCommand({
        type: 'fire_munition',
        unitId: shooter.id,
        targetTrackId: trackId,
        profileId: this.profileId,
        count,
        coldCoast: allowColdCoast,
      });
      if (ack.accepted) {
        remainingAmmo -= count;
        totalDispatched += count;
      } else {
        lastReason = ack.reason;
      }
    }

    if (totalDispatched === 0) {
      this.lastFireMessage = lastReason ?? '发射指令被拒绝';
      this.emitState();
      return { accepted: false, reason: this.lastFireMessage };
    }

    this.lastFireMessage = `${shooter.id} 已发射 ${totalDispatched} 枚 ${
      this.profileId === 'light_interceptor' ? '拦截弹' : allowColdCoast ? '冷漂鱼雷' : '鱼雷'
    }`;
    this.emitState();
    return { accepted: true };
  }

  /**
   * One-click anti-missile assignment: fires `light_interceptor` against incoming
   * munition tracks (using selected targets if munitions, or all incoming tracks).
   */
  async assignInterceptorsToIncoming(shooter: UnitEntity | null): Promise<CommandAck> {
    const incomingIds = this.snapshot.tracks
      .filter(
        (t) =>
          t.suspectedKind === 'munition' &&
          (t.confidence === 'confirmed' || t.confidence === 'uncertain'),
      )
      .map((t) => t.trackId);

    if (incomingIds.length === 0) {
      this.lastFireMessage = '当前无确认/误差区间内的来袭弹药航迹';
      this.emitState();
      return { accepted: false, reason: this.lastFireMessage };
    }

    const selectedIncoming = this.selectedTargetTrackIds.filter((id) =>
      incomingIds.includes(id),
    );
    const targetIds = selectedIncoming.length > 0 ? selectedIncoming : incomingIds;

    this.profileId = 'light_interceptor';
    this.coldCoast = false;
    this.salvoCount = 1;
    return this.fireAtSelectedTargets(shooter, targetIds);
  }

  private handleSnapshot(snap: FactionSnapshot): void {
    this.snapshot = snap;
    this.advisories = computeEngagementAdvisories(snap);

    // Prune target selections that vanished or dropped to non-targetable states
    const validIds = new Set(
      snap.tracks
        .filter((t) => t.confidence === 'confirmed' || t.confidence === 'uncertain')
        .map((t) => t.trackId),
    );
    this.selectedTargetTrackIds = this.selectedTargetTrackIds.filter((id) => validIds.has(id));
    this.emitState();
  }

  private emitState(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
