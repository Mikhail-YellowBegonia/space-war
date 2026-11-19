import { UNIT_CONFIGS, type FactionSnapshot, type TransferMode, type UnitEntity } from '@space-war/shared';
import type {
  CommandInteractionMode,
  OrbitInteractionManager,
  OrbitInteractionState,
} from '../interaction/index.js';
import type { IWorldProvider } from '../net/index.js';
import {
  formatBingoSummary,
  formatDeltaVKmPerSec,
  formatDurationMmSs,
  formatIrRisk,
  formatTransferModeTitle,
} from './formatters.js';

export interface OrbitCommandHudOptions {
  root: HTMLElement;
  provider: IWorldProvider;
  interaction: OrbitInteractionManager;
  onResetCamera?: () => void;
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
  private readonly provider: IWorldProvider;
  private readonly interaction: OrbitInteractionManager;
  private readonly onResetCamera?: () => void;

  private snapshot: FactionSnapshot;
  private interactionState: OrbitInteractionState;
  private readonly unsubProvider: () => void;
  private readonly unsubInteraction: () => void;

  constructor(options: OrbitCommandHudOptions) {
    this.root = options.root;
    this.provider = options.provider;
    this.interaction = options.interaction;
    this.onResetCamera = options.onResetCamera;

    this.snapshot = this.provider.getSnapshot();
    this.interactionState = this.interaction.getState();

    this.root.addEventListener('click', this.handleClick);
    this.unsubProvider = this.provider.subscribe((snap) => {
      this.snapshot = snap;
      this.render();
    });
    this.unsubInteraction = this.interaction.subscribe((state) => {
      this.interactionState = state;
      this.render();
    });

    this.render();
  }

  dispose(): void {
    this.root.removeEventListener('click', this.handleClick);
    this.unsubProvider();
    this.unsubInteraction();
  }

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
    }
  };

  private render(): void {
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

    this.root.innerHTML = `
      <div class="cic-topbar">
        <div class="cic-clock">MOCK 10Hz · T+${formatDurationMmSs(snapshot.gameTimeSec)} · ORE ${Math.round(snapshot.resources.ore)} · PROP ${Math.round(snapshot.resources.propellant)}</div>
        <div class="cic-modes">
          ${modeBtn('select', '选择', '1')}
          ${modeBtn('orbit_insertion', '进入轨道', '2')}
          ${modeBtn('intercept', '交会拦截', '3')}
          <button class="cic-btn" data-action="reset-camera">[0] 复位视角</button>
        </div>
        ${modeDetailHtml}
        ${statusLine}
      </div>
      <div class="cic-unit-dock">${unitButtonsHtml}</div>
      ${cardsHtml}
      ${modalHtml}
    `;
  }
}
