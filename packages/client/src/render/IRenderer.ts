import type {
  CelestialBody,
  KeplerOrbit,
  MunitionEntity,
  SensorTrack,
  TransferOption,
  UnitEntity,
  Vec2,
  VfxEvent,
} from '@space-war/shared';
import type { Camera2D } from '../camera/index.js';
import type { EngagementAdvisory, ScreenBoxRect } from '../interaction/fireControlMath.js';

/**
 * Minimal Canvas2D drawing interface compatible with browser `CanvasRenderingContext2D`
 * and headless test mocks.
 */
export interface Canvas2DContextLike {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  globalAlpha: number;
  save(): void;
  restore(): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
    counterclockwise?: boolean,
  ): void;
  rect(x: number, y: number, w: number, h: number): void;
  fill(): void;
  stroke(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  setLineDash(segments: number[]): void;
}

export interface TransferPreviewRenderData {
  option: TransferOption;
  draftOrbit?: KeplerOrbit | null;
  apsisHandles?: { periapsis: Vec2; apoapsis: Vec2 } | null;
}

export interface RenderFrameState {
  gameTimeSec: number;
  viewportWidth: number;
  viewportHeight: number;
  camera: Camera2D;
  bodies: readonly CelestialBody[];
  units: readonly UnitEntity[];
  ownMunitions?: readonly MunitionEntity[];
  tracks?: readonly SensorTrack[];
  selectedUnitId?: string | null;
  selectedTargetTrackIds?: readonly string[];
  focusedBodyId?: string | null;
  previewTransfer?: TransferPreviewRenderData | null;
  boxSelectRect?: ScreenBoxRect | null;
  engagementAdvisories?: readonly EngagementAdvisory[];
  vfxEvents?: readonly VfxEvent[];
}

export interface IRenderer {
  render(frame: RenderFrameState): void;
  resize?(width: number, height: number, dpr: number): void;
  dispose?(): void;
}
