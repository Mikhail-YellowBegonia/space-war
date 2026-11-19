import { SOLAR_SYSTEM_BODIES, type FactionId } from '@space-war/shared';
import { getClientBootBanner } from './app.js';
import { Camera2D, CameraController } from './camera/index.js';
import {
  FireControlManager,
  LogisticsBuildController,
  OrbitInteractionManager,
} from './interaction/index.js';
import {
  MockWorldProvider,
  WsWorldProvider,
  type IWorldProvider,
} from './net/index.js';
import { SolarSystemVectorRenderer } from './render/index.js';
import { OrbitCommandHud, type HudConnectionConfig } from './ui/index.js';

function resolveDefaultWsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

function parseInitialConnectionParams(): {
  mode: 'mock' | 'ws';
  roomId: string;
  faction: FactionId;
} {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get('mode') === 'ws' ? 'ws' : 'mock';
  const roomId = params.get('room')?.trim() || 'alpha-1';
  const faction: FactionId = params.get('faction') === 'mars' ? 'mars' : 'earth';
  return { mode, roomId, faction };
}

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

  const initial = parseInitialConnectionParams();
  let currentMode: 'mock' | 'ws' = initial.mode;
  let currentRoomId = initial.roomId;
  let currentFaction: FactionId = initial.faction;

  let provider: IWorldProvider;
  let interaction: OrbitInteractionManager;
  let fireControl: FireControlManager;
  let logistics: LogisticsBuildController;
  let unsubWsStatus: (() => void) | null = null;
  let hud: OrbitCommandHud | null = null;

  const createSession = (
    mode: 'mock' | 'ws',
    roomId: string,
    faction: FactionId,
  ): {
    provider: IWorldProvider;
    interaction: OrbitInteractionManager;
    fireControl: FireControlManager;
    logistics: LogisticsBuildController;
  } => {
    currentMode = mode;
    currentRoomId = roomId;
    currentFaction = faction;

    if (mode === 'ws') {
      const wsProvider = new WsWorldProvider({
        url: resolveDefaultWsUrl(),
        roomId,
        preferredFaction: faction,
      });
      unsubWsStatus = wsProvider.onStatusChange((statusInfo) => {
        hud?.updateConnectionStatus(statusInfo);
      });
      return {
        provider: wsProvider,
        interaction: new OrbitInteractionManager(wsProvider, SOLAR_SYSTEM_BODIES),
        fireControl: new FireControlManager(wsProvider),
        logistics: new LogisticsBuildController(wsProvider),
      };
    }

    const mockProvider = new MockWorldProvider({ faction, autoStart: true });
    return {
      provider: mockProvider,
      interaction: new OrbitInteractionManager(mockProvider, SOLAR_SYSTEM_BODIES),
      fireControl: new FireControlManager(mockProvider),
      logistics: new LogisticsBuildController(mockProvider),
    };
  };

  const buildConnectionConfig = (): HudConnectionConfig => ({
    mode: currentMode,
    roomId: currentRoomId,
    preferredFaction: currentFaction,
    wsStatus: provider instanceof WsWorldProvider ? provider.getStatusInfo() : null,
    onSwitchMode: switchConnectionMode,
  });

  const switchConnectionMode = (
    nextMode: 'mock' | 'ws',
    roomId: string,
    faction: FactionId,
  ): void => {
    unsubWsStatus?.();
    unsubWsStatus = null;
    logistics.dispose();
    fireControl.dispose();
    interaction.dispose();
    provider.dispose();

    const next = createSession(nextMode, roomId, faction);
    provider = next.provider;
    interaction = next.interaction;
    fireControl = next.fireControl;
    logistics = next.logistics;
    hud?.rebind(provider, interaction, buildConnectionConfig(), fireControl, logistics);
  };

  const initialSession = createSession(currentMode, currentRoomId, currentFaction);
  provider = initialSession.provider;
  interaction = initialSession.interaction;
  fireControl = initialSession.fireControl;
  logistics = initialSession.logistics;

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

  hud = hudRoot
    ? new OrbitCommandHud({
        root: hudRoot,
        provider,
        interaction,
        fireControl,
        logistics,
        onResetCamera: () => camera.resetOverview(),
        connection: buildConnectionConfig(),
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
  let boxSelecting = false;

  const handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) {
      return;
    }
    const local = getLocalPoint(event);
    const logState = logistics.getState();
    if (logState.pendingDetourRouteId) {
      void logistics.setDetourWaypoint(logState.pendingDetourRouteId, camera.screenToWorld(local));
      return;
    }
    if (logState.pendingRelayPlacement) {
      void logistics.placeRelayDepotAt(camera.screenToWorld(local));
      return;
    }
    if (interaction.getState().mode === 'fire' || event.shiftKey) {
      boxSelecting = true;
      fireControl.beginTargetBoxOrPick(local);
      return;
    }
    leftDragging = interaction.beginPointerAction(local, camera);
  };

  const handlePointerMove = (event: PointerEvent): void => {
    const local = getLocalPoint(event);
    if (boxSelecting) {
      fireControl.updateTargetBoxDrag(local);
      return;
    }
    if (!leftDragging) {
      return;
    }
    interaction.updatePointerDrag(local, camera);
  };

  const handlePointerUp = (event: PointerEvent): void => {
    if (event.button !== 0) {
      return;
    }
    if (boxSelecting) {
      boxSelecting = false;
      fireControl.endTargetBoxOrPick(getLocalPoint(event), camera);
      return;
    }
    if (!leftDragging) {
      return;
    }
    leftDragging = false;
    interaction.endPointerAction();
  };

  const handleKeyDown = (event: KeyboardEvent): void => {
    const active = document.activeElement as HTMLElement | null;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'SELECT')) {
      return;
    }
    if (event.key === 'Home' || event.key === '0') {
      camera.resetOverview();
    } else if (event.key === '1') {
      interaction.setMode('select');
    } else if (event.key === '2') {
      interaction.setMode('orbit_insertion');
    } else if (event.key === '3') {
      interaction.setMode('intercept');
    } else if (event.key === '4') {
      interaction.setMode('fire');
    } else if (event.key === '5') {
      hud?.toggleDrawer('logistics');
    } else if (event.key === '6') {
      hud?.toggleDrawer('build');
    } else if (event.key === 'f' || event.key === 'F') {
      void fireControl.fireAtSelectedTargets(interaction.getSelectedUnit());
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
    unsubWsStatus?.();
    cameraController.dispose();
    hud?.dispose();
    logistics.dispose();
    fireControl.dispose();
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
    const fireState = fireControl.getState();
    const chosenOption = interaction.getSelectedOption();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderer.render({
      gameTimeSec: snap.gameTimeSec,
      viewportWidth: widthCss,
      viewportHeight: heightCss,
      camera,
      bodies: SOLAR_SYSTEM_BODIES,
      units: snap.ownUnits,
      ownMunitions: snap.ownMunitions,
      tracks: snap.tracks,
      selectedUnitId: uiState.selectedUnitId,
      selectedTargetTrackIds: fireState.selectedTargetTrackIds,
      focusedBodyId: uiState.interceptTarget?.refId ?? null,
      boxSelectRect: fireState.boxSelectRect,
      engagementAdvisories: fireState.advisories,
      vfxEvents: snap.vfxEvents,
      faction: snap.faction,
      ownWonder: snap.ownWonder,
      routes: snap.routes,
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
