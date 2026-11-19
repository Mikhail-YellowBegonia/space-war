import {
  TIME_SCALE_CONFIG,
  type BingoWarningLevel,
  type TransferMode,
  type TransferOption,
} from '@space-war/shared';

export function formatDeltaVKmPerSec(dvAuPerSec: number): string {
  const kmPerSec = Math.max(0, dvAuPerSec) * TIME_SCALE_CONFIG.auPerSecToKmPerSec;
  return `${kmPerSec.toFixed(2)} km/s`;
}

export function formatDurationMmSs(totalSeconds: number): string {
  const clamped = Math.max(0, Math.round(totalSeconds));
  const mins = Math.floor(clamped / 60);
  const secs = clamped % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function formatTransferModeTitle(mode: TransferMode): string {
  switch (mode) {
    case 'fuel':
      return '节油方案 (Fuel)';
    case 'fast':
      return '速度方案 (Fast)';
    case 'stealth':
      return '隐蔽方案 (Stealth)';
  }
}

export function formatIrRisk(estimatedPeakIr: number): { label: string; percent: string } {
  const pct = Math.round(Math.max(0, Math.min(1, estimatedPeakIr)) * 100);
  if (pct >= 70) {
    return { label: '极高', percent: `${pct}%` };
  }
  if (pct >= 30) {
    return { label: '中', percent: `${pct}%` };
  }
  return { label: '低', percent: `${pct}%` };
}

export function formatBingoSummary(
  option: TransferOption,
  unitRemainingDv: number,
): { level: BingoWarningLevel; text: string } {
  const afterDv = Math.max(0, unitRemainingDv - option.totalDeltaV);
  const bingoStr = formatDeltaVKmPerSec(option.bingoDeltaV);
  const afterStr = formatDeltaVKmPerSec(afterDv);

  switch (option.bingoWarning) {
    case 'red':
      return {
        level: 'red',
        text: `RED 单程警示 · 剩余 ${afterStr} < 返航 ${bingoStr}`,
      };
    case 'amber':
      return {
        level: 'amber',
        text: `AMBER 余量接近红线 · 剩余 ${afterStr} / 返航 ${bingoStr}`,
      };
    case 'safe':
      return {
        level: 'safe',
        text: `SAFE · 剩余 ${afterStr} / 返航 ${bingoStr}`,
      };
  }
}
