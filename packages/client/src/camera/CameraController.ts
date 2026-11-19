import { CAMERA_LIMITS, type Camera2D } from './Camera2D.js';

export interface CameraControllerOptions {
  element: HTMLElement;
  camera: Camera2D;
  onCameraChange?: () => void;
}

/**
 * Binds wheel zoom and middle/right mouse drag panning to a DOM element (typically the CIC canvas).
 */
export class CameraController {
  private readonly element: HTMLElement;
  private readonly camera: Camera2D;
  private readonly onCameraChange?: () => void;

  private activePointerId: number | null = null;
  private activeButton: number | null = null;
  private lastClientX = 0;
  private lastClientY = 0;
  private dragMoved = false;
  private suppressNextContextMenu = false;

  constructor(options: CameraControllerOptions) {
    this.element = options.element;
    this.camera = options.camera;
    this.onCameraChange = options.onCameraChange;

    this.element.addEventListener('wheel', this.handleWheel, { passive: false });
    this.element.addEventListener('pointerdown', this.handlePointerDown);
    this.element.addEventListener('pointermove', this.handlePointerMove);
    this.element.addEventListener('pointerup', this.handlePointerUp);
    this.element.addEventListener('pointercancel', this.handlePointerUp);
    this.element.addEventListener('contextmenu', this.handleContextMenu);
  }

  dispose(): void {
    this.element.removeEventListener('wheel', this.handleWheel);
    this.element.removeEventListener('pointerdown', this.handlePointerDown);
    this.element.removeEventListener('pointermove', this.handlePointerMove);
    this.element.removeEventListener('pointerup', this.handlePointerUp);
    this.element.removeEventListener('pointercancel', this.handlePointerUp);
    this.element.removeEventListener('contextmenu', this.handleContextMenu);
  }

  private getLocalPoint(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.element.getBoundingClientRect();
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  }

  private readonly handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const delta = event.deltaY;
    if (delta === 0) {
      return;
    }

    const steps = Math.max(-3, Math.min(3, delta / 100));
    const scaleFactor = Math.pow(CAMERA_LIMITS.zoomStepFactor, steps);
    const anchor = this.getLocalPoint(event.clientX, event.clientY);
    this.camera.zoomAtScreenPos(scaleFactor, anchor);
    this.onCameraChange?.();
  };

  private readonly handlePointerDown = (event: PointerEvent): void => {
    // Support middle-click (1) and right-click (2) drag for camera panning.
    if (event.button !== 1 && event.button !== 2) {
      return;
    }

    this.activePointerId = event.pointerId;
    this.activeButton = event.button;
    this.lastClientX = event.clientX;
    this.lastClientY = event.clientY;
    this.dragMoved = false;

    if (typeof this.element.setPointerCapture === 'function') {
      this.element.setPointerCapture(event.pointerId);
    }
    if (event.button === 1) {
      event.preventDefault();
    }
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (this.activePointerId !== event.pointerId) {
      return;
    }

    const dx = event.clientX - this.lastClientX;
    const dy = event.clientY - this.lastClientY;
    if (dx === 0 && dy === 0) {
      return;
    }

    if (Math.hypot(dx, dy) > 2) {
      this.dragMoved = true;
    }

    this.lastClientX = event.clientX;
    this.lastClientY = event.clientY;
    this.camera.panByScreenDelta(dx, dy);
    this.onCameraChange?.();
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (this.activePointerId !== event.pointerId) {
      return;
    }

    if (this.activeButton === 2 && this.dragMoved) {
      this.suppressNextContextMenu = true;
    }

    if (typeof this.element.releasePointerCapture === 'function') {
      try {
        this.element.releasePointerCapture(event.pointerId);
      } catch {
        // Ignore if pointer capture was already released.
      }
    }

    this.activePointerId = null;
    this.activeButton = null;
    this.dragMoved = false;
  };

  private readonly handleContextMenu = (event: MouseEvent): void => {
    if (this.suppressNextContextMenu) {
      event.preventDefault();
      this.suppressNextContextMenu = false;
    }
  };
}
