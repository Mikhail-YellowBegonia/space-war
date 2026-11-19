import {
  MUNITION_CONFIGS,
  UNIT_CONFIGS,
  type FactionId,
  type FactionSnapshot,
  type MunitionProfileId,
  type TransferMode,
  type UnitEntity,
} from '@space-war/shared';
import {
  FireControlManager,
  isTrackTargetableForFire,
  type CommandInteractionMode,
  type FireControlState,
  type OrbitInteractionManager,
  type OrbitInteractionState,
} from '../interaction/index.js';
import type { IWorldProvider, WsStatusInfo } from '../net/index.js';
import {
  formatBingoSummary,
  formatDeltaVKmPerSec,
  formatDurationMmSs,
  formatIrRisk,
  formatTransferModeTitle,
} from './formatters.js';
import {
  UnitControlPanelController,
  buildUnitControlViewModel,
} from './UnitControlPanelController.js';

export interface HudConnectionConfig {
  mode: 'mock' | 'ws';
  roomId: string;
  preferredFaction: FactionId;
  wsStatus?: WsStatusInfo | null;
  onSwitchMode: (mode: 'mock' | 'ws', roomId: string, preferredFaction: FactionId) => void;
}

export interface OrbitCommandHudOptions {
  root: HTMLElement;
  provider: IWorldProvider;
  interaction: OrbitInteractionManager;
  fireControl?: FireControlManager;
  onResetCamera?: () => void;
  connection?: HudConnectionConfig;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function propulsionBadge(unit: UnitEntity): string {
  if (unit.propulsion === 'nuclear') return 'NUC';
  if (unit.propulsion === 'electric') return 'ELEC';
  return 'CHEM';
}

/**
 * CIC command HUD overlay for unit selection, explicit Orbit/Intercept mode switching,
 * 3-plan transfer comparison cards, and Bingo delta-v red-line confirmation modal.
 */
export class OrbitCommandHud {
  private readonly root: HTMLElement;
  private provider: IWorldProvider;
  private interaction: OrbitInteractionManager;
  private fireControl: FireControlManager;
  private readonly ownsFireControl: boolean;
  private readonly unitController: UnitControlPanelController;
  private readonly onResetCamera?: () => void;
  private connection?: HudConnectionConfig;

  private snapshot: FactionSnapshot;
  private interactionState: OrbitInteractionState;
  private fireState: FireControlState;
  private unsubProvider: () => void;
  private unsubInteraction: () => void;
  private unsubFireControl: () => void;

  constructor(options: OrbitCommandHudOptions) {
    this.root = options.root;
    this.provider = options.provider;
    this.interaction = options.interaction;
    this.ownsFireControl = !options.fireControl;
    this.fireControl = options.fireControl ?? new FireControlManager(this.provider);
    this.unitController = new UnitControlPanelController(this.provider);
    this.onResetCamera = options.onResetCamera;
    this.connection = options.connection;

    this.snapshot = this.provider.getSnapshot();
    this.interactionState = this.interaction.getState();
    this.fireState = this.fireControl.getState();

    this.root.addEventListener('click', this.handleClick);
    this.root.addEventListener('change', this.handleInputChange);
    this.unsubProvider = this.provider.subscribe((snap) => {
      this.snapshot = snap;
      this.render();
    });
    this.unsubInteraction = this.interaction.subscribe((state) => {
      this.interactionState = state;
      this.render();
    });
    this.unsubFireControl = this.fireControl.subscribe((state) => {
      this.fireState = state;
      this.render();
    });

    this.render();
  }

  /**
   * Rebinds the HUD to a newly created provider/interaction pair (e.g. Mock <-> WS switch).
   */
  rebind(
    provider: IWorldProvider,
    interaction: OrbitInteractionManager,
    connection?: HudConnectionConfig,
    fireControl?: FireControlManager,
  ): void {
    this.unsubProvider();
    this.unsubInteraction();
    this.unsubFireControl();
    this.provider = provider;
    this.interaction = interaction;
    if (fireControl) {
      this.fireControl = fireControl;
    } else {
      this.fireControl.setProvider(provider);
    }
    this.unitController.setProvider(provider);
    this.connection = connection;

    this.snapshot = this.provider.getSnapshot();
    this.interactionState = this.interaction.getState();
    this.fireState = this.fireControl.getState();

    this.unsubProvider = this.provider.subscribe((snap) => {
      this.snapshot = snap;
      this.render();
    });
    this.unsubInteraction = this.interaction.subscribe((state) => {
      this.interactionState = state;
      this.render();
    });
    this.unsubFireControl = this.fireControl.subscribe((state) => {
      this.fireState = state;
      this.render();
    });
    this.render();
  }

  updateConnectionStatus(wsStatus: WsStatusInfo | null): void {
    if (this.connection) {
      this.connection = { ...this.connection, wsStatus };
      this.render();
    }
  }

  dispose(): void {
    this.root.removeEventListener('click', this.handleClick);
    this.root.removeEventListener('change', this.handleInputChange);
    this.unsubProvider();
    this.unsubInteraction();
    this.unsubFireControl();
    if (this.ownsFireControl) {
      this.fireControl.dispose();
    }
  }

  private readonly handleInputChange = (event: Event): void => {
    const target = event.target as HTMLInputElement | null;
    if (!target || target.id !== 'cic-ladar-slider') {
      return;
    }
    const unitId = this.interactionState.selectedUnitId;
    if (!unitId) return;
    const deg = Number(target.value);
    if (Number.isFinite(deg)) {
      void this.unitController.setLadarAngleDeg(unitId, deg);
    }
  };

  private readonly handleClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    const actionEl = target?.closest('[data-action]') as HTMLElement | null;
    if (!actionEl) {
      return;
    }

    const action = actionEl.dataset.action;
    switch (action) {
      case 'set-mode': {
        const mode = actionEl.dataset.mode as CommandInteractionMode | undefined;
        if (mode) this.interaction.setMode(mode);
        break;
      }
      case 'select-unit': {
        const unitId = actionEl.dataset.unitId;
        if (unitId) this.interaction.selectUnit(unitId);
        break;
      }
      case 'pick-target': {
        const refId = actionEl.dataset.refId;
        const label = actionEl.dataset.label;
        if (refId) this.interaction.setInterceptTarget(refId, label);
        break;
      }
      case 'select-transfer-mode': {
        const mode = actionEl.dataset.transferMode as TransferMode | undefined;
        if (mode) this.interaction.selectTransferMode(mode);
        break;
      }
      case 'execute-transfer': {
        void this.interaction.requestExecute();
        break;
      }
      case 'clear-preview': {
        this.interaction.clearPreview();
        break;
      }
      case 'confirm-bingo': {
        void this.interaction.confirmBingoExecute();
        break;
      }
      case 'cancel-bingo': {
        this.interaction.cancelBingoConfirm();
        break;
      }
      case 'reset-camera': {
        this.onResetCamera?.();
        break;
      }
      case 'switch-net-mode': {
        if (!this.connection) break;
        const nextMode = actionEl.dataset.netMode as 'mock' | 'ws' | undefined;
        if (!nextMode) break;
        const roomInput = this.root.querySelector<HTMLInputElement>('#cic-room-id');
        const factionSelect = this.root.querySelector<HTMLSelectElement>('#cic-faction-select');
        const roomId = roomInput?.value.trim() || this.connection.roomId;
        const faction = (factionSelect?.value as FactionId | undefined) ?? this.connection.preferredFaction;
        this.connection.onSwitchMode(nextMode, roomId, faction);
        break;
      }
      case 'unit-emcon-silent': {
        const unitId = this.interactionState.selectedUnitId;
        if (unitId) void this.unitController.toggleEmconSilent(unitId);
        break;
      }
      case 'unit-radiators': {
        const unitId = this.interactionState.selectedUnitId;
        if (unitId) void this.unitController.toggleRadiators(unitId);
        break;
      }
      case 'unit-radar': {
        const unitId = this.interactionState.selectedUnitId;
        if (unitId) void this.unitController.toggleRadar(unitId);
        break;
      }
      case 'unit-jammer': {
        const unitId = this.interactionState.selectedUnitId;
        if (unitId) void this.unitController.toggleJammer(unitId);
        break;
      }
      case 'unit-ladar-toggle': {
        const unitId = this.interactionState.selectedUnitId;
        if (unitId) void this.unitController.toggleLadar(unitId);
        break;
      }
      case 'unit-ladar-step': {
        const unitId = this.interactionState.selectedUnitId;
        const delta = Number(actionEl.dataset.delta);
        if (unitId && Number.isFinite(delta)) {
          void this.unitController.rotateLadarByDeg(unitId, delta);
        }
        break;
      }
      case 'unit-launch-drone': {
        const unitId = this.interactionState.selectedUnitId;
        const droneKind = actionEl.dataset.droneKind as 'drone_recon' | 'drone_ew' | undefined;
        if (unitId && droneKind) {
          void this.unitController.launchDrone(unitId, droneKind);
        }
        break;
      }
      case 'fire-profile': {
        const profileId = actionEl.dataset.profileId as MunitionProfileId | undefined;
        if (profileId) this.fireControl.setProfileId(profileId);
        break;
      }
      case 'fire-salvo': {
        const count = Number(actionEl.dataset.count);
        if (Number.isFinite(count)) this.fireControl.setSalvoCount(count);
        break;
      }
      case 'fire-cold-coast': {
        this.fireControl.setColdCoast(!this.fireState.coldCoast);
        break;
      }
      case 'fire-pick-track': {
        const trackId = actionEl.dataset.trackId;
        if (trackId) this.fireControl.selectTargetTrack(trackId);
        break;
      }
      case 'fire-execute': {
        const shooter = this.interaction.getSelectedUnit();
        void this.fireControl.fireAtSelectedTargets(shooter);
        break;
      }
      case 'fire-intercept-incoming': {
        const shooter = this.interaction.getSelectedUnit();
        void this.fireControl.assignInterceptorsToIncoming(shooter);
        break;
      }
    }
  };

  private render(): void {
    const activeEl =
      typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
    if (
      activeEl &&
      (activeEl.id === 'cic-room-id' ||
        activeEl.id === 'cic-faction-select' ||
        activeEl.id === 'cic-ladar-slider')
    ) {
      return;
    }

    const { snapshot, interactionState } = this;
    const selectedUnit =
      snapshot.ownUnits.find((u) => u.id === interactionState.selectedUnitId) ?? null;

    const unitButtonsHtml = snapshot.ownUnits
      .map((u) => {
        const isSelected = u.id === interactionState.selectedUnitId;
        const dvText = formatDeltaVKmPerSec(u.deltaV);
        const burning = u.plannedBurns.length > 0 ? ' · BURN' : '';
        return `<button class="cic-chip ${isSelected ? 'active' : ''}" data-action="select-unit" data-unit-id="${escapeHtml(u.id)}">
          <span class="chip-id">${escapeHtml(u.id)}</span>
          <span class="chip-meta">${propulsionBadge(u)} · ${dvText}${burning}</span>
        </button>`;
      })
      .join('');

    const modeBtn = (mode: CommandInteractionMode, label: string, hotkey: string): string =>
      `<button class="cic-btn ${interactionState.mode === mode ? 'active' : ''}" data-action="set-mode" data-mode="${mode}">[${hotkey}] ${label}</button>`;

    let modeDetailHtml = '';
    if (interactionState.mode === 'orbit_insertion') {
      const handles = interactionState.apsisHandles;
      modeDetailHtml = `<div class="cic-hint">
        拖拽星图或 <b>P</b>(近日点)/<b>A</b>(远日点) 手柄调节目标椭圆
        ${handles ? ` · rp=${handles.rp.toFixed(2)} AU / ra=${handles.ra.toFixed(2)} AU` : ''}
      </div>`;
    } else if (interactionState.mode === 'intercept') {
      modeDetailHtml = `<div class="cic-hint">
        点击星图天体/航迹，或快捷选择目标:
        <button class="cic-mini-btn" data-action="pick-target" data-ref-id="mars" data-label="Mars">Mars</button>
        <button class="cic-mini-btn" data-action="pick-target" data-ref-id="eros" data-label="433 Eros">433 Eros</button>
        <button class="cic-mini-btn" data-action="pick-target" data-ref-id="ceres" data-label="1 Ceres">1 Ceres</button>
        <button class="cic-mini-btn" data-action="pick-target" data-ref-id="trk-mars-home" data-label="trk-mars-home">Mars Track</button>
        ${interactionState.interceptTarget ? ` · 已锁定: <b>${escapeHtml(interactionState.interceptTarget.label)}</b>` : ''}
      </div>`;
    }

    let cardsHtml = '';
    if (interactionState.options && selectedUnit) {
      const cards = interactionState.options
        .map((opt) => {
          const isChosen = opt.mode === interactionState.selectedTransferMode;
          const dtSec = Math.max(0, opt.arrivalSec - snapshot.gameTimeSec);
          const ir = formatIrRisk(opt.estimatedPeakIr);
          const bingo = formatBingoSummary(opt, selectedUnit.deltaV);
          const reasonHtml =
            !opt.feasible && opt.reason
              ? `<div class="card-reason">${escapeHtml(opt.reason)}</div>`
              : '';

          return `<div class="transfer-card ${isChosen ? 'selected' : ''} ${opt.feasible ? '' : 'infeasible'} bingo-${opt.bingoWarning}" data-action="select-transfer-mode" data-transfer-mode="${opt.mode}">
            <div class="card-header">
              <span>${escapeHtml(formatTransferModeTitle(opt.mode))}</span>
              <span class="card-status">${opt.feasible ? '可行' : '不可行'}</span>
            </div>
            <div class="card-metrics">
              <div>耗时 Δt: <b>${formatDurationMmSs(dtSec)}</b></div>
              <div>消耗 Δv: <b>${formatDeltaVKmPerSec(opt.totalDeltaV)}</b></div>
              <div>IR 曝光: <b>${ir.label} (${ir.percent})</b></div>
            </div>
            <div class="card-bingo bingo-${bingo.level}">${escapeHtml(bingo.text)}</div>
            ${reasonHtml}
          </div>`;
        })
        .join('');

      const selectedOpt =
        interactionState.options.find((o) => o.mode === interactionState.selectedTransferMode) ??
        interactionState.options[0];

      cardsHtml = `<section class="cic-panel cic-transfer-panel">
        <div class="panel-title">
          <span>机动转移方案对比 · ${escapeHtml(selectedUnit.id)} (${escapeHtml(UNIT_CONFIGS[selectedUnit.kind].name)})</span>
          <button class="cic-mini-btn" data-action="clear-preview">清除</button>
        </div>
        <div class="transfer-cards">${cards}</div>
        <div class="panel-actions">
          <button class="cic-exec-btn ${selectedOpt.bingoWarning === 'red' ? 'danger' : selectedOpt.bingoWarning === 'amber' ? 'warn' : ''}" data-action="execute-transfer" ${selectedOpt.feasible ? '' : 'disabled'}>
            ${selectedOpt.bingoWarning === 'red' ? '⚠ 执行单程机动 (BINGO RED)' : selectedOpt.bingoWarning === 'amber' ? '执行机动 (接近返航线)' : '执行机动 [Enter]'}
          </button>
        </div>
      </section>`;
    }

    let modalHtml = '';
    if (interactionState.pendingBingoConfirm && selectedUnit) {
      const opt =
        interactionState.options?.find((o) => o.mode === interactionState.selectedTransferMode) ??
        null;
      const afterDv = opt ? Math.max(0, selectedUnit.deltaV - opt.totalDeltaV) : 0;
      const bingoDv = opt ? opt.bingoDeltaV : 0;

      modalHtml = `<div class="cic-modal-backdrop">
        <div class="cic-modal">
          <div class="modal-title">⚠ BINGO Δv 红线警告 (ONE-WAY TRIP)</div>
          <p class="modal-body">
            <b>${escapeHtml(selectedUnit.id)}</b> 完成此次机动后预计剩余 Δv 为
            <b>${formatDeltaVKmPerSec(afterDv)}</b>，低于返回最近友方补给站所需的保守余量
            <b>${formatDeltaVKmPerSec(bingoDv)}</b>。若无油船前出加注，该舰船将在惯性滑行后耗尽推进剂。
          </p>
          <div class="modal-actions">
            <button class="cic-btn" data-action="cancel-bingo">取消 [Esc]</button>
            <button class="cic-exec-btn danger" data-action="confirm-bingo">确认单程点火</button>
          </div>
        </div>
      </div>`;
    }

    const statusLine = interactionState.statusMessage
      ? `<div class="cic-status">${escapeHtml(interactionState.statusMessage)}</div>`
      : '';

    const conn = this.connection;
    const netLabel =
      conn?.mode === 'ws'
        ? `WS ${conn.wsStatus?.status.toUpperCase() ?? 'CONNECTING'} · ${snapshot.faction.toUpperCase()}${
            conn.wsStatus?.rttMs != null ? ` · ${conn.wsStatus.rttMs}ms` : ''
          }`
        : `MOCK 10Hz · ${snapshot.faction.toUpperCase()}`;

    const netSwitchHtml = conn
      ? `<div class="cic-netbar">
          <button class="cic-mini-btn ${conn.mode === 'mock' ? 'active' : ''}" data-action="switch-net-mode" data-net-mode="mock">Mock 单机</button>
          <input id="cic-room-id" class="cic-input" type="text" value="${escapeHtml(conn.roomId)}" placeholder="Room ID" />
          <select id="cic-faction-select" class="cic-select">
            <option value="earth" ${conn.preferredFaction === 'earth' ? 'selected' : ''}>Earth</option>
            <option value="mars" ${conn.preferredFaction === 'mars' ? 'selected' : ''}>Mars</option>
          </select>
          <button class="cic-mini-btn ${conn.mode === 'ws' ? 'active' : ''}" data-action="switch-net-mode" data-net-mode="ws">WS 联机</button>
        </div>`
      : '';

    this.root.innerHTML = `
      <div class="cic-topbar">
        <div class="cic-clock">${escapeHtml(netLabel)} · T+${formatDurationMmSs(snapshot.gameTimeSec)} · ORE ${Math.round(snapshot.resources.ore)} · PROP ${Math.round(snapshot.resources.propellant)}</div>
        ${netSwitchHtml}
        <div class="cic-modes">
          ${modeBtn('select', '选择', '1')}
          ${modeBtn('orbit_insertion', '进入轨道', '2')}
          ${modeBtn('intercept', '交会拦截', '3')}
          ${modeBtn('fire', '武器火控', '4')}
          <button class="cic-btn" data-action="reset-camera">[0] 复位视角</button>
        </div>
        ${modeDetailHtml}
        ${this.renderEngagementAdvisories()}
        ${statusLine}
      </div>
      <div class="cic-unit-dock">${unitButtonsHtml}</div>
      ${this.renderUnitControlTerminal()}
      ${this.renderFireControlPanel(selectedUnit)}
      ${cardsHtml}
      ${modalHtml}
    `;
  }

  private renderEngagementAdvisories(): string {
    const { advisories } = this.fireState;
    if (advisories.length === 0) return '';
    const incomingCount = advisories.filter((a) => a.kind === 'incoming_munition').length;
    const brawlCount = advisories.filter((a) => a.kind === 'close_range_brawl').length;
    const laserCount = advisories.filter((a) => a.kind === 'laser_envelope').length;

    const parts: string[] = [];
    if (incomingCount > 0) parts.push(`⚠ 来袭弹药威胁 (${incomingCount})`);
    if (brawlCount > 0) parts.push(`⚔ 近战交会告警 (${brawlCount})`);
    if (laserCount > 0) parts.push(`✦ 激光射程内目标 (${laserCount})`);

    return `<div class="cic-alert">${escapeHtml(parts.join(' · '))}</div>`;
  }

  private renderFireControlPanel(selectedUnit: UnitEntity | null): string {
    if (
      this.interactionState.mode !== 'fire' &&
      this.fireState.selectedTargetTrackIds.length === 0
    ) {
      return '';
    }
    if (this.interactionState.options) {
      return '';
    }

    const targetableTracks = this.snapshot.tracks.filter(isTrackTargetableForFire);
    const incomingCount = targetableTracks.filter((t) => t.suspectedKind === 'munition').length;
    const selectedSet = new Set(this.fireState.selectedTargetTrackIds);
    const canColdCoast = MUNITION_CONFIGS[this.fireState.profileId].canColdCoast;

    const trackButtons = targetableTracks
      .map((t) => {
        const isIncoming = t.suspectedKind === 'munition';
        return `<button class="cic-mini-btn ${selectedSet.has(t.trackId) ? 'active' : ''} ${isIncoming ? 'threat' : ''}" data-action="fire-pick-track" data-track-id="${escapeHtml(t.trackId)}">
          ${isIncoming ? '⚠ ' : ''}${escapeHtml(t.trackId)} (${t.confidence})
        </button>`;
      })
      .join('');

    return `<section class="cic-panel cic-fire-panel">
      <div class="panel-title">
        <span>BVR 武器火控 // ${selectedUnit ? `${escapeHtml(selectedUnit.id)} (弹药 ${selectedUnit.ammoStock})` : '未选舰'}</span>
      </div>
      <div class="cic-hint">在星图上点击目标或拖拽框选来袭弹药航迹 · 快捷键 [F] 齐射</div>
      <div class="fire-controls-row">
        <button class="cic-mini-btn ${this.fireState.profileId === 'light_interceptor' ? 'active' : ''}" data-action="fire-profile" data-profile-id="light_interceptor">轻型拦截弹</button>
        <button class="cic-mini-btn ${this.fireState.profileId === 'heavy_torpedo' ? 'active' : ''}" data-action="fire-profile" data-profile-id="heavy_torpedo">重型鱼雷</button>
        <button class="cic-mini-btn ${this.fireState.salvoCount === 1 ? 'active' : ''}" data-action="fire-salvo" data-count="1">x1</button>
        <button class="cic-mini-btn ${this.fireState.salvoCount === 2 ? 'active' : ''}" data-action="fire-salvo" data-count="2">x2</button>
        <button class="cic-mini-btn ${this.fireState.salvoCount === 4 ? 'active' : ''}" data-action="fire-salvo" data-count="4">x4</button>
        <button class="cic-mini-btn ${this.fireState.coldCoast ? 'active' : ''}" data-action="fire-cold-coast" ${canColdCoast ? '' : 'disabled'}>冷漂 ${this.fireState.coldCoast ? 'ON' : 'OFF'}</button>
      </div>
      <div class="fire-targets">${trackButtons || '<span class="chip-meta">暂无可火控航迹</span>'}</div>
      ${this.fireState.lastFireMessage ? `<div class="cic-status">${escapeHtml(this.fireState.lastFireMessage)}</div>` : ''}
      <div class="panel-actions fire-actions">
        ${incomingCount > 0 ? `<button class="cic-btn" data-action="fire-intercept-incoming">一键反导拦截 (${incomingCount})</button>` : ''}
        <button class="cic-exec-btn" data-action="fire-execute" ${selectedUnit && selectedUnit.ammoStock > 0 && this.fireState.selectedTargetTrackIds.length > 0 ? '' : 'disabled'}>发射齐射 [F]</button>
      </div>
    </section>`;
  }

  private renderUnitControlTerminal(): string {
    const vm = buildUnitControlViewModel(this.snapshot, this.interactionState.selectedUnitId);
    if (!vm) {
      return '';
    }

    const { unit } = vm;
    const subTag = (label: string, state: UnitEntity['subsystems']['propulsion']): string =>
      `<span class="sub-chip sub-${state}">${label}:${state === 'normal' ? 'OK' : state === 'damaged' ? 'DMG' : 'OFF'}</span>`;

    const ladarSection = vm.ladarSupported
      ? `<div class="term-row term-ladar">
          <div class="term-label">LADAR 扫描指向</div>
          <div class="term-controls">
            <button class="cic-mini-btn ${vm.ladarEnabled ? 'active' : ''}" data-action="unit-ladar-toggle">${vm.ladarEnabled ? '开启' : '关闭'}</button>
            <button class="cic-mini-btn" data-action="unit-ladar-step" data-delta="-15">-15°</button>
            <input id="cic-ladar-slider" class="cic-slider" type="range" min="0" max="359" value="${vm.ladarAngleDeg}" />
            <button class="cic-mini-btn" data-action="unit-ladar-step" data-delta="15">+15°</button>
            <span class="term-angle">${vm.ladarEnabled ? `${vm.ladarAngleDeg}°` : 'OFF'}</span>
          </div>
        </div>`
      : '';

    const droneSection =
      vm.droneCapacity > 0
        ? `<div class="term-row">
            <div class="term-label">无人机舱 (${vm.droneCapacity})</div>
            <div class="term-controls">
              <button class="cic-mini-btn" data-action="unit-launch-drone" data-drone-kind="drone_recon">+ 侦察机</button>
              <button class="cic-mini-btn" data-action="unit-launch-drone" data-drone-kind="drone_ew">+ 电战诱饵</button>
            </div>
          </div>`
        : '';

    return `<aside class="cic-panel cic-unit-terminal">
      <div class="panel-title">
        <span>单舰终端 // ${escapeHtml(unit.id)}</span>
        ${vm.inUmbra ? '<span class="umbra-badge">UMBRA</span>' : ''}
      </div>
      <div class="term-stats">
        <span>HP ${Math.round(unit.hp)}/${unit.maxHp}</span>
        <span>Δv ${formatDeltaVKmPerSec(unit.deltaV)}</span>
        <span>${propulsionBadge(unit)}</span>
      </div>
      <div class="term-subs">
        ${subTag('PROP', unit.subsystems.propulsion)}
        ${subTag('SENS', unit.subsystems.sensors)}
        ${subTag('WEAP', unit.subsystems.weapons)}
        ${subTag('THERM', unit.subsystems.thermal)}
      </div>
      <div class="term-heat">
        <div class="term-heat-head">
          <span>热沉蓄热 (HEAT SINK)</span>
          <span>${unit.heat.toFixed(1)} / ${unit.maxHeat} (${vm.heatPercent}%)</span>
        </div>
        <div class="heat-track">
          <div class="heat-fill heat-${vm.heatLevel}" style="width: ${vm.heatPercent}%"></div>
        </div>
      </div>
      <div class="term-toggles">
        <button class="cic-btn ${unit.emconSilent ? 'active emcon-on' : ''}" data-action="unit-emcon-silent">静默冷漂 ${unit.emconSilent ? 'ON' : 'OFF'}</button>
        <button class="cic-btn ${unit.radiatorsOpen ? 'active' : ''}" data-action="unit-radiators">散热片 ${unit.radiatorsOpen ? 'OPEN' : 'SHUT'}</button>
        <button class="cic-btn ${unit.radarActive ? 'active' : ''}" data-action="unit-radar">主动雷达 ${unit.radarActive ? 'ON' : 'OFF'}</button>
        <button class="cic-btn ${unit.jammerActive ? 'active ew-on' : ''}" data-action="unit-jammer">电子干扰 ${unit.jammerActive ? 'ON' : 'OFF'}</button>
      </div>
      ${ladarSection}
      ${droneSection}
    </aside>`;
  }
}
