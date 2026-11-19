import type { Vec2 } from '@space-war/shared';

export type SemanticZoomTier = 'strategic' | 'operational' | 'tactical';

export const CAMERA_LIMITS = {
  /** Tightest local rendezvous zoom: 0.05 AU across the smaller viewport dimension. */
  minViewSpanAu: 0.05,
  /** Widest full inner solar system zoom: 7.0 AU across the smaller viewport dimension. */
  maxViewSpanAu: 7.0,
  /** Maximum camera center offset from the Sun along each axis (AU). */
  maxPanExtentAu: 5.5,
  /** Wheel zoom sensitivity per normalized wheel tick. */
  zoomStepFactor: 1.14,
} as const;

export const SEMANTIC_ZOOM_THRESHOLDS = {
  /** Above this span (AU), render strategic overview symbology. */
  strategicMinSpanAu: 2.2,
  /** At or below this span (AU), render local tactical rendezvous symbology. */
  tacticalMaxSpanAu: 0.45,
} as const;

/**
 * Classifies the active semantic zoom tier from the current visible AU span.
 */
export function getSemanticZoomTier(viewSpanAu: number): SemanticZoomTier {
  if (viewSpanAu > SEMANTIC_ZOOM_THRESHOLDS.strategicMinSpanAu) {
    return 'strategic';
  }
  if (viewSpanAu <= SEMANTIC_ZOOM_THRESHOLDS.tacticalMaxSpanAu) {
    return 'tactical';
  }
  return 'operational';
}

export interface Camera2DOptions {
  center?: Vec2;
  viewSpanAu?: number;
  viewportWidth?: number;
  viewportHeight?: number;
}

export interface WorldBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Double-precision (float64) 2D heliocentric camera.
 * Subtracts `center` in float64 before scaling to screen pixels to eliminate jitter across
 * 0.05 AU rendezvous views through 7.0 AU solar-system overviews.
 */
export class Camera2D {
  private centerX: number;
  private centerY: number;
  private viewSpanAu: number;
  private viewportWidth: number;
  private viewportHeight: number;

  constructor(options: Camera2DOptions = {}) {
    this.centerX = clamp(
      options.center?.x ?? 0,
      -CAMERA_LIMITS.maxPanExtentAu,
      CAMERA_LIMITS.maxPanExtentAu,
    );
    this.centerY = clamp(
      options.center?.y ?? 0,
      -CAMERA_LIMITS.maxPanExtentAu,
      CAMERA_LIMITS.maxPanExtentAu,
    );
    this.viewSpanAu = clamp(
      options.viewSpanAu ?? CAMERA_LIMITS.maxViewSpanAu,
      CAMERA_LIMITS.minViewSpanAu,
      CAMERA_LIMITS.maxViewSpanAu,
    );
    this.viewportWidth = Math.max(1, options.viewportWidth ?? 1280);
    this.viewportHeight = Math.max(1, options.viewportHeight ?? 720);
  }

  getCenter(): Vec2 {
    return { x: this.centerX, y: this.centerY };
  }

  setCenter(center: Vec2): void {
    this.centerX = clamp(center.x, -CAMERA_LIMITS.maxPanExtentAu, CAMERA_LIMITS.maxPanExtentAu);
    this.centerY = clamp(center.y, -CAMERA_LIMITS.maxPanExtentAu, CAMERA_LIMITS.maxPanExtentAu);
  }

  getViewSpanAu(): number {
    return this.viewSpanAu;
  }

  setViewSpanAu(spanAu: number): void {
    this.viewSpanAu = clamp(
      spanAu,
      CAMERA_LIMITS.minViewSpanAu,
      CAMERA_LIMITS.maxViewSpanAu,
    );
  }

  getViewport(): { width: number; height: number } {
    return { width: this.viewportWidth, height: this.viewportHeight };
  }

  setViewport(width: number, height: number): void {
    this.viewportWidth = Math.max(1, width);
    this.viewportHeight = Math.max(1, height);
  }

  /**
   * Pixels per AU along both axes, anchored to the smaller viewport dimension so
   * `viewSpanAu` always fits cleanly on screen.
   */
  getPixelsPerAu(): number {
    const limitingDim = Math.min(this.viewportWidth, this.viewportHeight);
    return limitingDim / this.viewSpanAu;
  }

  getSemanticZoomTier(): SemanticZoomTier {
    return getSemanticZoomTier(this.viewSpanAu);
  }

  /**
   * Converts a float64 world position (AU) to screen pixel coordinates.
   */
  worldToScreen(worldPos: Vec2): Vec2 {
    const pixelsPerAu = this.getPixelsPerAu();
    return {
      x: (worldPos.x - this.centerX) * pixelsPerAu + this.viewportWidth * 0.5,
      y: (worldPos.y - this.centerY) * pixelsPerAu + this.viewportHeight * 0.5,
    };
  }

  /**
   * Converts screen pixel coordinates back to float64 world coordinates (AU).
   */
  screenToWorld(screenPos: Vec2): Vec2 {
    const pixelsPerAu = this.getPixelsPerAu();
    return {
      x: (screenPos.x - this.viewportWidth * 0.5) / pixelsPerAu + this.centerX,
      y: (screenPos.y - this.viewportHeight * 0.5) / pixelsPerAu + this.centerY,
    };
  }

  /**
   * Pans the camera center by a pointer drag delta in screen pixels.
   */
  panByScreenDelta(dxPx: number, dyPx: number): void {
    const pixelsPerAu = this.getPixelsPerAu();
    this.setCenter({
      x: this.centerX - dxPx / pixelsPerAu,
      y: this.centerY - dyPx / pixelsPerAu,
    });
  }

  /**
   * Zooms the view span by `scaleFactor` (< 1 zooms in, > 1 zooms out) while keeping
   * the world coordinate under `anchorScreenPos` fixed on screen.
   */
  zoomAtScreenPos(scaleFactor: number, anchorScreenPos: Vec2): void {
    if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) {
      return;
    }

    const worldBefore = this.screenToWorld(anchorScreenPos);
    const nextSpan = clamp(
      this.viewSpanAu * scaleFactor,
      CAMERA_LIMITS.minViewSpanAu,
      CAMERA_LIMITS.maxViewSpanAu,
    );
    if (nextSpan === this.viewSpanAu) {
      return;
    }

    this.viewSpanAu = nextSpan;
    const worldAfter = this.screenToWorld(anchorScreenPos);
    this.setCenter({
      x: this.centerX + (worldBefore.x - worldAfter.x),
      y: this.centerY + (worldBefore.y - worldAfter.y),
    });
  }

  /**
   * Returns the world-space axis-aligned bounding box currently visible in the viewport.
   */
  getVisibleWorldBounds(): WorldBounds {
    const pixelsPerAu = this.getPixelsPerAu();
    const halfWidthAu = (this.viewportWidth * 0.5) / pixelsPerAu;
    const halfHeightAu = (this.viewportHeight * 0.5) / pixelsPerAu;
    return {
      minX: this.centerX - halfWidthAu,
      maxX: this.centerX + halfWidthAu,
      minY: this.centerY - halfHeightAu,
      maxY: this.centerY + halfHeightAu,
    };
  }

  /**
   * Resets to the full inner solar system overview centered on the Sun.
   */
  resetOverview(): void {
    this.centerX = 0;
    this.centerY = 0;
    this.viewSpanAu = CAMERA_LIMITS.maxViewSpanAu;
  }
}
