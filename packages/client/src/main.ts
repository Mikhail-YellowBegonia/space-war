import { SOLAR_SYSTEM_BODIES } from '@space-war/shared';
import { getClientBootBanner } from './app.js';
import { Camera2D, CameraController } from './camera/index.js';
import { OrbitInteractionManager } from './interaction/index.js';
import { MockWorldProvider } from './net/index.js';
import { SolarSystemVectorRenderer } from './render/index.js';
import { OrbitCommandHud } from './ui/index.js';

function bootstrapClient(): void {
  const banner = document.getElementById('hud-boot');
  const canvas = document.getElementById('viewport');
  const hudRoot = document.getElementById('hud-root');

  if (!(canvas instanceof HTMLCanvasElement)) {
    if (banner) {
      banner.textContent = getClientBootBanner();
    }
    return;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return;
  }

  const provider = new MockWorldProvider({ faction: 'earth', autoStart: true });
  const interaction = new OrbitInteractionManager(provider, SOLAR_SYSTEM_BODIES);

  const camera = new Camera2D({
    center: { x: 0, y: 0 },
    viewSpanAu: 7.0,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  });

  const renderer = new SolarSystemVectorRenderer(ctx);
  let widthCss = window.innerWidth;
  let heightCss = window.innerHeight;
  let dpr = window.devicePixelRatio || 1;

  const syncCanvasSize = (): void => {
    dpr = window.devicePixelRatio || 1;
    widthCss = Math.max(1, window.innerWidth);
    heightCss = Math.max(1, window.innerHeight);
    canvas.width = Math.max(1, Math.floor(widthCss * dpr));
    canvas.height = Math.max(1, Math.floor(heightCss * dpr));
    camera.setViewport(widthCss, heightCss);
  };

  syncCanvasSize();

  const cameraController = new CameraController({
    element: canvas,
    camera,
  });

  const hud = hudRoot
    ? new OrbitCommandHud({
        root: hudRoot,
        provider,
        interaction,
        onResetCamera: () => camera.resetOverview(),
      })
    : null;

  const getLocalPoint = (event: PointerEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  };

  let leftDragging = false;

  const handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) {
      return;
    }
    leftDragging = interaction.beginPointerAction(getLocalPoint(event), camera);
  };

  const handlePointerMove = (event: PointerEvent): void => {
    if (!leftDragging) {
      return;
    }
    interaction.updatePointerDrag(getLocalPoint(event), camera);
  };

  const handlePointerUp = (event: PointerEvent): void => {
    if (event.button !== 0 || !leftDragging) {
      return;
    }
    leftDragging = false;
    interaction.endPointerAction();
  };

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Home' || event.key === '0') {
      camera.resetOverview();
    } else if (event.key === '1') {
      interaction.setMode('select');
    } else if (event.key === '2') {
      interaction.setMode('orbit_insertion');
    } else if (event.key === '3') {
      interaction.setMode('intercept');
    } else if (event.key === 'Enter') {
      void interaction.requestExecute();
    } else if (event.key === 'Escape') {
      if (interaction.getState().pendingBingoConfirm) {
        interaction.cancelBingoConfirm();
      } else {
        interaction.setMode('select');
      }
    }
  };

  canvas.addEventListener('pointerdown', handlePointerDown);
  window.addEventListener('pointermove', handlePointerMove);
  window.addEventListener('pointerup', handlePointerUp);
  window.addEventListener('pointercancel', handlePointerUp);
  window.addEventListener('resize', syncCanvasSize);
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('beforeunload', () => {
    cameraController.dispose();
    hud?.dispose();
    interaction.dispose();
    provider.dispose();
    canvas.removeEventListener('pointerdown', handlePointerDown);
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
    window.removeEventListener('pointercancel', handlePointerUp);
    window.removeEventListener('resize', syncCanvasSize);
    window.removeEventListener('keydown', handleKeyDown);
  });

  const baseBanner = getClientBootBanner();

  const renderLoop = (): void => {
    const snap = provider.getSnapshot();
    const uiState = interaction.getState();
    const chosenOption = interaction.getSelectedOption();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderer.render({
      gameTimeSec: snap.gameTimeSec,
      viewportWidth: widthCss,
      viewportHeight: heightCss,
      camera,
      bodies: SOLAR_SYSTEM_BODIES,
      units: snap.ownUnits,
      tracks: snap.tracks,
      selectedUnitId: uiState.selectedUnitId,
      focusedBodyId: uiState.interceptTarget?.refId ?? null,
      previewTransfer: chosenOption
        ? {
            option: chosenOption,
            draftOrbit: uiState.draftOrbit,
            apsisHandles: uiState.apsisHandles
              ? {
                  periapsis: uiState.apsisHandles.periapsis,
                  apoapsis: uiState.apsisHandles.apoapsis,
                }
              : null,
          }
        : null,
    });

    if (banner) {
      const span = camera.getViewSpanAu().toFixed(2);
      const tier = camera.getSemanticZoomTier().toUpperCase();
      banner.textContent = `${baseBanner} // SPAN ${span} AU [${tier}] // WHEEL ZOOM · RMB/MMB PAN`;
    }

    requestAnimationFrame(renderLoop);
  };

  requestAnimationFrame(renderLoop);
}

bootstrapClient();
