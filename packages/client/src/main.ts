import { SOLAR_SYSTEM_BODIES, getBodyStateAt, type FactionId } from '@space-war/shared';
import { getClientBootBanner } from './app.js';
import { CicSoundEngine } from './audio/index.js';
import { Camera2D, CameraController, type CameraFollowTarget } from './camera/index.js';
import {
  FireControlManager,
  LogisticsBuildController,
  OrbitInteractionManager,
  pickEntityAtScreenPos,
} from './interaction/index.js';
import {
  MockWorldProvider,
  WsWorldProvider,
  type IWorldProvider,
} from './net/index.js';
import { SolarSystemVectorRenderer } from './render/index.js';
import {
  MatchFlowController,
  OrbitCommandHud,
  type HudConnectionConfig,
} from './ui/index.js';

function resolveDefaultWsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

function parseInitialConnectionParams(): {
  mode: 'mock' | 'ws';
  roomId: string;
  faction: FactionId;
  skipLobby: boolean;
} {
  const params = new URLSearchParams(window.location.search);
  const hasModeParam = params.has('mode');
  const mode = params.get('mode') === 'ws' ? 'ws' : 'mock';
  const roomId = params.get('room')?.trim() || 'alpha-1';
  const faction: FactionId = params.get('faction') === 'mars' ? 'mars' : 'earth';
  const skipLobby = hasModeParam || params.get('autostart') === '1';
  return { mode, roomId, faction, skipLobby };
}

function bootstrapClient(): void {
  const banner = document.getElementById('hud-boot');
  const canvas = document.getElementById('viewport');
  const crtOverlay = document.getElementById('crt-overlay');
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

  const matchFlow = new MatchFlowController({
    initialPhase: initial.skipLobby ? 'playing' : 'lobby',
    lobby: {
      playMode: initial.mode,
      roomId: initial.roomId,
      faction: initial.faction,
    },
    crtEnabled: true,
    soundMuted: false,
  });
  const soundEngine = new CicSoundEngine({ muted: false });

  const syncCrtDom = (enabled: boolean): void => {
    canvas.classList.toggle('crt-active', enabled);
    crtOverlay?.classList.toggle('crt-off', !enabled);
  };
  const unsubCrtDom = matchFlow.subscribe((flowState) => {
    syncCrtDom(flowState.crtEnabled);
  });

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
    autoStartMock = true,
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

    const mockProvider = new MockWorldProvider({
      faction,
      autoStart: autoStartMock,
      timeScale: 0.5,
    });
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

    const next = createSession(nextMode, roomId, faction, true);
    provider = next.provider;
    interaction = next.interaction;
    fireControl = next.fireControl;
    logistics = next.logistics;
    camera.clearFollowTarget();
    hud?.rebind(provider, interaction, buildConnectionConfig(), fireControl, logistics);
  };

  const initialSession = createSession(
    currentMode,
    currentRoomId,
    currentFaction,
    initial.skipLobby,
  );
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

  const followEntity = (target: CameraFollowTarget | null, desiredSpanAu?: number): void => {
    camera.setFollowTarget(target);
    if (target && desiredSpanAu !== undefined && camera.getViewSpanAu() > desiredSpanAu) {
      camera.setViewSpanAu(desiredSpanAu);
    }
    hud?.notifyCameraStateChange();
  };

  const toggleFollowSelectedUnit = (): void => {
    const selected = interaction.getSelectedUnit();
    const cur = camera.getFollowTarget();
    if (!selected) {
      followEntity(null);
      return;
    }
    if (cur?.kind === 'unit' && cur.id === selected.id) {
      followEntity(null);
    } else {
      followEntity({ kind: 'unit', id: selected.id, label: selected.id }, 0.85);
    }
  };

  const cameraController = new CameraController({
    element: canvas,
    camera,
    onCameraChange: () => {
      hud?.notifyCameraStateChange();
    },
  });

  hud = hudRoot
    ? new OrbitCommandHud({
        root: hudRoot,
        provider,
        interaction,
        fireControl,
        logistics,
        matchFlow,
        soundEngine,
        onLaunchSession: switchConnectionMode,
        onResetCamera: () => {
          camera.resetOverview();
          hud?.notifyCameraStateChange();
        },
        getFollowTarget: () => camera.getFollowTarget(),
        onToggleFollowSelected: toggleFollowSelectedUnit,
        onFollowBody: (bodyId, label) => {
          followEntity({ kind: 'body', id: bodyId, label }, 1.4);
        },
        onClearFollow: () => {
          followEntity(null);
        },
        getTimeScale: () =>
          provider instanceof MockWorldProvider ? provider.getTimeScale() : 0.5,
        onSetTimeScale: (scale) => {
          if (provider instanceof MockWorldProvider) {
            provider.setTimeScale(scale);
          }
        },
        connection: buildConnectionConfig(),
      })
    : null;

  const getLocalPoint = (event: MouseEvent): { x: number; y: number } => {
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

  const handleDoubleClick = (event: MouseEvent): void => {
    const local = getLocalPoint(event);
    const snap = provider.getSnapshot();
    const picked = pickEntityAtScreenPos(local, camera, snap, SOLAR_SYSTEM_BODIES, 22);
    if (!picked) {
      return;
    }
    if (picked.kind === 'unit') {
      interaction.selectUnit(picked.unit.id);
      followEntity({ kind: 'unit', id: picked.unit.id, label: picked.unit.id }, 0.8);
    } else if (picked.kind === 'body') {
      followEntity({ kind: 'body', id: picked.body.id, label: picked.body.name }, 1.4);
    }
  };

  const handleKeyDown = (event: KeyboardEvent): void => {
    const active = document.activeElement as HTMLElement | null;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'SELECT')) {
      return;
    }
    if (event.key === 'Home' || event.key === '0') {
      camera.resetOverview();
      hud?.notifyCameraStateChange();
    } else if (event.key === 't' || event.key === 'T') {
      toggleFollowSelectedUnit();
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
    } else if (event.key === 'c' || event.key === 'C') {
      matchFlow.toggleCrt();
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
  canvas.addEventListener('dblclick', handleDoubleClick);
  window.addEventListener('pointermove', handlePointerMove);
  window.addEventListener('pointerup', handlePointerUp);
  window.addEventListener('pointercancel', handlePointerUp);
  window.addEventListener('resize', syncCanvasSize);
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('beforeunload', () => {
    unsubWsStatus?.();
    unsubCrtDom();
    cameraController.dispose();
    hud?.dispose();
    matchFlow.dispose();
    soundEngine.dispose();
    logistics.dispose();
    fireControl.dispose();
    interaction.dispose();
    provider.dispose();
    canvas.removeEventListener('pointerdown', handlePointerDown);
    canvas.removeEventListener('dblclick', handleDoubleClick);
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
    window.removeEventListener('pointercancel', handlePointerUp);
    window.removeEventListener('resize', syncCanvasSize);
    window.removeEventListener('keydown', handleKeyDown);
  });

  const baseBanner = getClientBootBanner();

  const renderLoop = (): void => {
    const snap = provider.getSnapshot();
    const follow = camera.getFollowTarget();
    if (follow) {
      if (follow.kind === 'unit') {
        const targetUnit = snap.ownUnits.find((u) => u.id === follow.id && u.hp > 0);
        if (targetUnit) {
          camera.setCenter(targetUnit.pos);
        } else {
          camera.clearFollowTarget();
          hud?.notifyCameraStateChange();
        }
      } else {
        const cel = snap.celestials.find((c) => c.id === follow.id);
        if (cel) {
          camera.setCenter(cel.pos);
        } else {
          const body = SOLAR_SYSTEM_BODIES.find((b) => b.id === follow.id);
          if (body) {
            camera.setCenter(getBodyStateAt(body, snap.gameTimeSec).pos);
          }
        }
      }
    }

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
      const lockBadge = follow ? ` // LOCK ${follow.label.toUpperCase()}` : '';
      banner.textContent = `${baseBanner} // SPAN ${span} AU [${tier}]${lockBadge} // WHEEL ZOOM · RMB PAN · DBLCLICK FOLLOW`;
    }

    requestAnimationFrame(renderLoop);
  };

  requestAnimationFrame(renderLoop);
}

bootstrapClient();
