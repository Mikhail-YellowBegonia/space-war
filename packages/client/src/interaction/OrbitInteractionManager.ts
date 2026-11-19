import {
  SOLAR_SYSTEM_BODIES,
  UNIT_CONFIGS,
  getInterceptTransferOptions,
  getOrbitInsertionOptions,
  type CelestialBody,
  type FactionSnapshot,
  type InterceptTarget,
  type KeplerOrbit,
  type ResupplyPoint,
  type TransferMode,
  type TransferOption,
  type UnitEntity,
  type Vec2,
} from '@space-war/shared';
import type { Camera2D } from '../camera/index.js';
import type { IWorldProvider } from '../net/index.js';
import {
  buildOrbitFromTwoPointDrag,
  getOrbitApsisPositions,
  pickApsisHandleAtScreenPos,
  pickEntityAtScreenPos,
  updateOrbitFromApsisHandleDrag,
  type ApsisHandleKind,
  type ApsisPositions,
} from './orbitDragMath.js';

export type CommandInteractionMode = 'select' | 'orbit_insertion' | 'intercept';

export interface InterceptTargetRef {
  refId: string;
  label: string;
}

export interface OrbitInteractionState {
  mode: CommandInteractionMode;
  selectedUnitId: string | null;
  draftOrbit: KeplerOrbit | null;
  apsisHandles: ApsisPositions | null;
  interceptTarget: InterceptTargetRef | null;
  options: [TransferOption, TransferOption, TransferOption] | null;
  selectedTransferMode: TransferMode;
  pendingBingoConfirm: boolean;
  statusMessage: string | null;
}

export type ExecuteTransferResult =
  | { status: 'executed' }
  | { status: 'needs_bingo_confirm'; option: TransferOption }
  | { status: 'blocked'; reason: string };

export type InteractionStateListener = (state: OrbitInteractionState) => void;

/**
 * Coordinates orbital command modes (`select` / `orbit_insertion` / `intercept`),
 * 3-strategy transfer previews (`fuel` / `fast` / `stealth`), apsis ellipse dragging,
 * and Bingo delta-v red-line confirmation gating.
 */
export class OrbitInteractionManager {
  private readonly provider: IWorldProvider;
  private readonly bodies: readonly CelestialBody[];
  private readonly listeners = new Set<InteractionStateListener>();
  private readonly unsubscribeProvider: () => void;

  private snapshot: FactionSnapshot;
  private mode: CommandInteractionMode = 'select';
  private selectedUnitId: string | null = null;
  private draftOrbit: KeplerOrbit | null = null;
  private interceptTarget: InterceptTargetRef | null = null;
  private options: [TransferOption, TransferOption, TransferOption] | null = null;
  private selectedTransferMode: TransferMode = 'fuel';
  private pendingBingoConfirm = false;
  private statusMessage: string | null = null;

  private activeDragHandle: ApsisHandleKind | null = null;
  private activeFreeDragAnchor: Vec2 | null = null;

  constructor(provider: IWorldProvider, bodies: readonly CelestialBody[] = SOLAR_SYSTEM_BODIES) {
    this.provider = provider;
    this.bodies = bodies;
    this.snapshot = provider.getSnapshot();

    // Auto-select the first mobile ship if present for smooth onboarding
    const firstMobile =
      this.snapshot.ownUnits.find((u) => UNIT_CONFIGS[u.kind].maxDeltaV > 0 && u.kind !== 'home_base') ??
      this.snapshot.ownUnits[0];
    this.selectedUnitId = firstMobile?.id ?? null;

    this.unsubscribeProvider = provider.subscribe((snap) => {
      this.snapshot = snap;
      if (this.selectedUnitId && !snap.ownUnits.some((u) => u.id === this.selectedUnitId)) {
        this.selectedUnitId = null;
        this.clearPreview();
      }
      if (!this.selectedUnitId && snap.ownUnits.length > 0) {
        const autoPick =
          snap.ownUnits.find(
            (u) => UNIT_CONFIGS[u.kind].maxDeltaV > 0 && u.kind !== 'home_base',
          ) ?? snap.ownUnits[0];
        this.selectedUnitId = autoPick?.id ?? null;
      }
      this.emitState();
    });
  }

  dispose(): void {
    this.unsubscribeProvider();
    this.listeners.clear();
  }

  subscribe(listener: InteractionStateListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState(): OrbitInteractionState {
    return {
      mode: this.mode,
      selectedUnitId: this.selectedUnitId,
      draftOrbit: this.draftOrbit ? { ...this.draftOrbit } : null,
      apsisHandles: this.draftOrbit ? getOrbitApsisPositions(this.draftOrbit) : null,
      interceptTarget: this.interceptTarget ? { ...this.interceptTarget } : null,
      options: this.options,
      selectedTransferMode: this.selectedTransferMode,
      pendingBingoConfirm: this.pendingBingoConfirm,
      statusMessage: this.statusMessage,
    };
  }

  getSelectedUnit(): UnitEntity | null {
    if (!this.selectedUnitId) return null;
    return this.snapshot.ownUnits.find((u) => u.id === this.selectedUnitId) ?? null;
  }

  getSelectedOption(): TransferOption | null {
    if (!this.options) return null;
    return this.options.find((opt) => opt.mode === this.selectedTransferMode) ?? this.options[0];
  }

  selectUnit(unitId: string | null): void {
    this.selectedUnitId = unitId;
    this.pendingBingoConfirm = false;
    this.statusMessage = null;

    if (!unitId) {
      this.clearPreview();
      return;
    }

    if (this.mode === 'orbit_insertion') {
      const unit = this.getSelectedUnit();
      if (unit) {
        this.draftOrbit = { ...unit.orbit };
        this.recomputeOrbitOptions();
      }
    } else if (this.mode === 'intercept' && this.interceptTarget) {
      this.recomputeInterceptOptions();
    } else {
      this.options = null;
    }
    this.emitState();
  }

  setMode(mode: CommandInteractionMode): void {
    this.mode = mode;
    this.pendingBingoConfirm = false;
    this.statusMessage = null;
    this.activeDragHandle = null;
    this.activeFreeDragAnchor = null;

    if (mode === 'orbit_insertion') {
      this.interceptTarget = null;
      const unit = this.getSelectedUnit();
      if (unit) {
        this.draftOrbit = { ...unit.orbit };
        this.recomputeOrbitOptions();
      } else {
        this.draftOrbit = null;
        this.options = null;
      }
    } else if (mode === 'intercept') {
      this.draftOrbit = null;
      this.options = null;
      if (this.interceptTarget) {
        this.recomputeInterceptOptions();
      }
    } else {
      this.draftOrbit = null;
      this.interceptTarget = null;
      this.options = null;
    }

    this.emitState();
  }

  selectTransferMode(mode: TransferMode): void {
    this.selectedTransferMode = mode;
    this.pendingBingoConfirm = false;
    this.emitState();
  }

  updateDraftOrbit(targetOrbit: KeplerOrbit): void {
    this.mode = 'orbit_insertion';
    this.interceptTarget = null;
    this.draftOrbit = { ...targetOrbit };
    this.pendingBingoConfirm = false;
    this.statusMessage = null;
    this.recomputeOrbitOptions();
    this.emitState();
  }

  setInterceptTarget(refId: string, label?: string): boolean {
    const resolved = this.resolveInterceptTarget(refId);
    if (!resolved) {
      this.statusMessage = `无法锁定目标: ${refId}`;
      this.emitState();
      return false;
    }

    this.mode = 'intercept';
    this.draftOrbit = null;
    this.interceptTarget = { refId, label: label ?? resolved.label };
    this.pendingBingoConfirm = false;
    this.statusMessage = null;
    this.recomputeInterceptOptions();
    this.emitState();
    return true;
  }

  clearPreview(): void {
    this.draftOrbit = null;
    this.interceptTarget = null;
    this.options = null;
    this.pendingBingoConfirm = false;
    this.activeDragHandle = null;
    this.activeFreeDragAnchor = null;
    this.emitState();
  }

  /**
   * Handles left-button pointer down on the canvas for selecting units/targets or starting
   * an orbit-ellipse drag in `orbit_insertion` mode. Returns true if an interaction captured it.
   */
  beginPointerAction(screenPos: Vec2, camera: Camera2D): boolean {
    if (this.mode === 'orbit_insertion') {
      const unit = this.getSelectedUnit();
      if (!unit) {
        this.statusMessage = '请先选择一艘己方舰船';
        this.emitState();
        return false;
      }

      if (this.draftOrbit) {
        const handle = pickApsisHandleAtScreenPos(screenPos, camera, this.draftOrbit);
        if (handle) {
          this.activeDragHandle = handle;
          return true;
        }
      }

      // Allow picking another own unit by clicking directly on it; otherwise start free ellipse drag
      const picked = pickEntityAtScreenPos(screenPos, camera, this.snapshot, this.bodies);
      if (picked?.kind === 'unit') {
        this.selectUnit(picked.unit.id);
        return true;
      }

      this.activeFreeDragAnchor = { ...unit.pos };
      const dragWorld = camera.screenToWorld(screenPos);
      this.updateDraftOrbit(buildOrbitFromTwoPointDrag(this.activeFreeDragAnchor, dragWorld));
      return true;
    }

    const picked = pickEntityAtScreenPos(screenPos, camera, this.snapshot, this.bodies);
    if (!picked) {
      return false;
    }

    if (this.mode === 'intercept') {
      if (picked.kind === 'body') {
        this.setInterceptTarget(picked.body.id, picked.body.name);
        return true;
      }
      if (picked.kind === 'track') {
        this.setInterceptTarget(picked.track.trackId, picked.track.trackId);
        return true;
      }
      if (picked.kind === 'unit') {
        if (picked.unit.id === this.selectedUnitId) {
          return true;
        }
        // Targeting friendly tanker/station for rendezvous
        this.setInterceptTarget(picked.unit.id, picked.unit.id);
        return true;
      }
    }

    if (picked.kind === 'unit') {
      this.selectUnit(picked.unit.id);
      return true;
    }
    return false;
  }

  updatePointerDrag(screenPos: Vec2, camera: Camera2D): boolean {
    if (this.mode !== 'orbit_insertion') {
      return false;
    }

    const cursorWorld = camera.screenToWorld(screenPos);
    if (this.activeDragHandle && this.draftOrbit) {
      this.updateDraftOrbit(
        updateOrbitFromApsisHandleDrag(this.draftOrbit, this.activeDragHandle, cursorWorld),
      );
      return true;
    }

    if (this.activeFreeDragAnchor) {
      this.updateDraftOrbit(buildOrbitFromTwoPointDrag(this.activeFreeDragAnchor, cursorWorld));
      return true;
    }

    return false;
  }

  endPointerAction(): void {
    this.activeDragHandle = null;
    this.activeFreeDragAnchor = null;
  }

  /**
   * Attempts to execute the currently previewed maneuver. If `bingoWarning === 'red'`,
   * transitions into `pendingBingoConfirm` so the UI presents a confirmation dialog.
   */
  async requestExecute(): Promise<ExecuteTransferResult> {
    const unit = this.getSelectedUnit();
    if (!unit) {
      const reason = '未选中己方单位';
      this.statusMessage = reason;
      this.emitState();
      return { status: 'blocked', reason };
    }

    const option = this.getSelectedOption();
    if (!option) {
      const reason = '尚未生成转移预览方案';
      this.statusMessage = reason;
      this.emitState();
      return { status: 'blocked', reason };
    }

    if (!option.feasible) {
      const reason = option.reason ?? '当前方案不可行';
      this.statusMessage = reason;
      this.emitState();
      return { status: 'blocked', reason };
    }

    if (option.bingoWarning === 'red' && !this.pendingBingoConfirm) {
      this.pendingBingoConfirm = true;
      this.statusMessage = 'Bingo Δv 红色警报：该机动为单程航行，请二次确认';
      this.emitState();
      return { status: 'needs_bingo_confirm', option };
    }

    return this.dispatchSelectedTransfer(option);
  }

  async confirmBingoExecute(): Promise<ExecuteTransferResult> {
    const option = this.getSelectedOption();
    if (!option || !option.feasible) {
      this.pendingBingoConfirm = false;
      this.emitState();
      return { status: 'blocked', reason: option?.reason ?? '方案不可行' };
    }
    return this.dispatchSelectedTransfer(option);
  }

  cancelBingoConfirm(): void {
    this.pendingBingoConfirm = false;
    this.statusMessage = '已取消高风险单程机动';
    this.emitState();
  }

  private async dispatchSelectedTransfer(option: TransferOption): Promise<ExecuteTransferResult> {
    const unit = this.getSelectedUnit();
    if (!unit) {
      return { status: 'blocked', reason: '未选中单位' };
    }

    this.pendingBingoConfirm = false;

    if (this.mode === 'orbit_insertion' && this.draftOrbit) {
      const ack = await this.provider.sendCommand({
        type: 'plan_orbit_insertion',
        unitId: unit.id,
        targetOrbit: this.draftOrbit,
        mode: option.mode,
      });
      if (!ack.accepted) {
        this.statusMessage = ack.reason ?? '变轨指令被拒绝';
        this.emitState();
        return { status: 'blocked', reason: this.statusMessage };
      }
      this.statusMessage = `${unit.id} 已下达进入轨道指令 (${option.mode})`;
      this.clearPreview();
      return { status: 'executed' };
    }

    if (this.mode === 'intercept' && this.interceptTarget) {
      const ack = await this.provider.sendCommand({
        type: 'plan_intercept',
        unitId: unit.id,
        targetRefId: this.interceptTarget.refId,
        mode: option.mode,
      });
      if (!ack.accepted) {
        this.statusMessage = ack.reason ?? '交会指令被拒绝';
        this.emitState();
        return { status: 'blocked', reason: this.statusMessage };
      }
      this.statusMessage = `${unit.id} 已下达交会指令 -> ${this.interceptTarget.label} (${option.mode})`;
      this.clearPreview();
      return { status: 'executed' };
    }

    return { status: 'blocked', reason: '未处于有效的机动规划模式' };
  }

  private getFriendlyResupplySites(): ResupplyPoint[] {
    const sites: ResupplyPoint[] = [];
    for (const u of this.snapshot.ownUnits) {
      if (UNIT_CONFIGS[u.kind].logistics.canResupply) {
        sites.push({ id: u.id, orbit: u.orbit, pos: u.pos });
      }
    }
    return sites;
  }

  private resolveInterceptTarget(
    refId: string,
  ): { target: InterceptTarget; label: string } | null {
    const body = this.bodies.find((b) => b.id === refId && b.orbit !== null);
    if (body) {
      return { target: body, label: body.name };
    }
    const ownUnit = this.snapshot.ownUnits.find((u) => u.id === refId);
    if (ownUnit) {
      return { target: ownUnit, label: ownUnit.id };
    }
    const track = this.snapshot.tracks.find((t) => t.trackId === refId);
    if (track) {
      return { target: track, label: track.trackId };
    }
    return null;
  }

  private recomputeOrbitOptions(): void {
    const unit = this.getSelectedUnit();
    if (!unit || !this.draftOrbit) {
      this.options = null;
      return;
    }

    this.options = getOrbitInsertionOptions(
      {
        unit,
        nowSec: this.snapshot.gameTimeSec,
        celestialBodies: this.bodies,
        friendlyResupplySites: this.getFriendlyResupplySites(),
      },
      this.draftOrbit,
    );
  }

  private recomputeInterceptOptions(): void {
    const unit = this.getSelectedUnit();
    if (!unit || !this.interceptTarget) {
      this.options = null;
      return;
    }
    const resolved = this.resolveInterceptTarget(this.interceptTarget.refId);
    if (!resolved) {
      this.options = null;
      return;
    }

    this.options = getInterceptTransferOptions(
      {
        unit,
        nowSec: this.snapshot.gameTimeSec,
        celestialBodies: this.bodies,
        friendlyResupplySites: this.getFriendlyResupplySites(),
      },
      resolved.target,
    );
  }

  private emitState(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
