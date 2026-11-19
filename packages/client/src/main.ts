import { SOLAR_SYSTEM_BODIES } from '@space-war/shared';
import { createPreviewUnits, getClientBootBanner } from './app.js';
import { Camera2D, CameraController } from './camera/index.js';
import { SolarSystemVectorRenderer } from './render/index.js';

function bootstrapClient(): void {
  const banner = document.getElementById('hud-boot');
  const canvas = document.getElementById('viewport');
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

  const controller = new CameraController({
    element: canvas,
    camera,
  });

  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Home' || event.key === '0') {
      camera.resetOverview();
    }
  };

  window.addEventListener('resize', syncCanvasSize);
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('beforeunload', () => {
    controller.dispose();
    window.removeEventListener('resize', syncCanvasSize);
    window.removeEventListener('keydown', handleKeyDown);
  });

  const startMs = performance.now();
  const baseBanner = getClientBootBanner();

  const renderLoop = (nowMs: number): void => {
    const gameTimeSec = (nowMs - startMs) / 1000;
    const units = createPreviewUnits(gameTimeSec);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderer.render({
      gameTimeSec,
      viewportWidth: widthCss,
      viewportHeight: heightCss,
      camera,
      bodies: SOLAR_SYSTEM_BODIES,
      units,
      selectedUnitId: 'E-RCN-1',
    });

    if (banner) {
      const span = camera.getViewSpanAu().toFixed(2);
      const tier = camera.getSemanticZoomTier().toUpperCase();
      banner.textContent = `${baseBanner} // SPAN ${span} AU [${tier}] // WHEEL ZOOM · RMB/MMB PAN · [0] RESET`;
    }

    requestAnimationFrame(renderLoop);
  };

  requestAnimationFrame(renderLoop);
}

bootstrapClient();
