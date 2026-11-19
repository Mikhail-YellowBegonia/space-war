import {
  PROTOCOL_VERSION,
  SOLAR_SYSTEM_BODIES,
  orbitToState,
  type ClientMessage,
  type FactionSnapshot,
  type ServerMessage,
} from '@space-war/shared';
import { describe, expect, it } from 'vitest';
import { MockWorldProvider, WsWorldProvider, type WebSocketLike } from '../src/net/index.js';
import {
  UnitControlPanelController,
  buildUnitControlViewModel,
  degToRad,
  radToDeg360,
} from '../src/ui/index.js';

class InlineWsMock implements WebSocketLike {
  readyState = 0;
  readonly sent: ClientMessage[] = [];
  private readonly listeners = new Map<string, Set<(ev: unknown) => void>>();

  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (ev: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (ev: unknown) => void,
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ClientMessage);
  }

  close(): void {
    this.readyState = 3;
  }

  emitOpen(): void {
    this.readyState = 1;
    for (const fn of this.listeners.get('open') ?? []) fn({});
  }

  emitServer(msg: ServerMessage): void {
    const ev = { data: JSON.stringify(msg) };
    for (const fn of this.listeners.get('message') ?? []) fn(ev);
  }
}

describe('SW-14 unit control panel (EMCON, thermal, sensors, EW, and drones)', () => {
  it('toggles EMCON silent cold-coast, radiators, radar, and jammer with thermal feedback in MockWorldProvider', async () => {
    const provider = new MockWorldProvider({ faction: 'earth', autoStart: false });
    const controller = new UnitControlPanelController(provider);

    // Disable LADAR and activate radar on E-RCN-1, then enter EMCON silent cold-coast
    await controller.toggleLadar('E-RCN-1');
    await controller.toggleRadar('E-RCN-1');
    let vm = controller.getViewModel('E-RCN-1')!;
    expect(vm.unit.radarActive).toBe(true);
    expect(vm.unit.emconSilent).toBe(false);

    // One-click silent cold-coast turns off radiators, radar, and jammer
    await controller.toggleEmconSilent('E-RCN-1');
    vm = controller.getViewModel('E-RCN-1')!;
    expect(vm.unit.emconSilent).toBe(true);
    expect(vm.unit.radiatorsOpen).toBe(false);
    expect(vm.unit.radarActive).toBe(false);
    expect(vm.unit.jammerActive).toBe(false);

    // Step simulation: heat builds up while radiators are retracted
    for (let i = 0; i < 40; i++) {
      provider.step(1);
    }
    const heatedVm = controller.getViewModel('E-RCN-1')!;
    expect(heatedVm.unit.heat).toBeGreaterThan(0);

    // Opening radiators exits silent mode and cools down heat sink
    await controller.toggleRadiators('E-RCN-1');
    vm = controller.getViewModel('E-RCN-1')!;
    expect(vm.unit.radiatorsOpen).toBe(true);
    expect(vm.unit.emconSilent).toBe(false);

    for (let i = 0; i < 20; i++) {
      provider.step(1);
    }
    const cooledVm = controller.getViewModel('E-RCN-1')!;
    expect(cooledVm.unit.heat).toBeLessThan(heatedVm.unit.heat);

    // Toggle active jammer
    await controller.toggleJammer('E-RCN-1');
    expect(controller.getViewModel('E-RCN-1')!.unit.jammerActive).toBe(true);

    provider.dispose();
  });

  it('rotates and toggles LADAR scan sector angle and rejects unsupported hulls', async () => {
    const provider = new MockWorldProvider({ faction: 'earth', autoStart: false });
    const controller = new UnitControlPanelController(provider);

    await controller.setLadarAngleDeg('E-RCN-1', 90);
    let vm = controller.getViewModel('E-RCN-1')!;
    expect(vm.ladarSupported).toBe(true);
    expect(vm.ladarEnabled).toBe(true);
    expect(vm.ladarAngleDeg).toBe(90);
    expect(vm.unit.ladarTargetAngle).toBeCloseTo(degToRad(90), 10);

    await controller.rotateLadarByDeg('E-RCN-1', -105);
    vm = controller.getViewModel('E-RCN-1')!;
    expect(vm.ladarAngleDeg).toBe(345);
    expect(radToDeg360(vm.unit.ladarTargetAngle!)).toBeCloseTo(345, 6);

    await controller.toggleLadar('E-RCN-1');
    expect(controller.getViewModel('E-RCN-1')!.ladarEnabled).toBe(false);

    // Tanker has no LADAR
    const tankerRes = await controller.toggleLadar('E-TNK-1');
    expect(tankerRes.accepted).toBe(false);

    provider.dispose();
  });

  it('launches recon and EW drones within carrier capacity in MockWorldProvider', async () => {
    const provider = new MockWorldProvider({ faction: 'earth', autoStart: false });
    const controller = new UnitControlPanelController(provider);

    const beforeCount = provider.getSnapshot().ownUnits.length;
    const reconLaunch = await controller.launchDrone('E-RCN-1', 'drone_recon');
    expect(reconLaunch.accepted).toBe(true);

    const ewLaunch = await controller.launchDrone('E-RCN-1', 'drone_ew');
    expect(ewLaunch.accepted).toBe(true);

    const unitsAfter = provider.getSnapshot().ownUnits;
    expect(unitsAfter.length).toBe(beforeCount + 2);
    expect(unitsAfter.some((u) => u.kind === 'drone_recon')).toBe(true);
    expect(unitsAfter.some((u) => u.kind === 'drone_ew' && u.jammerActive)).toBe(true);

    // Exhaust remaining 2 drone slots (capacity = 4), 5th should fail
    expect((await controller.launchDrone('E-RCN-1', 'drone_recon')).accepted).toBe(true);
    expect((await controller.launchDrone('E-RCN-1', 'drone_ew')).accepted).toBe(true);
    expect((await controller.launchDrone('E-RCN-1', 'drone_recon')).accepted).toBe(false);

    provider.dispose();
  });

  it('dispatches exact PlayerCommands over WsWorldProvider and reflects server state updates', async () => {
    const sock = new InlineWsMock();
    const wsProvider = new WsWorldProvider({
      url: 'ws://localhost:3001',
      roomId: 'sw14-room',
      preferredFaction: 'earth',
      reconnectDelayMs: 0,
      socketFactory: () => sock,
    });
    const controller = new UnitControlPanelController(wsProvider);

    sock.emitOpen();
    sock.emitServer({
      type: 'room_joined',
      roomId: 'sw14-room',
      faction: 'earth',
      playerToken: 'tok-1',
      protocolVersion: PROTOCOL_VERSION,
    });

    const orbit = { a: 1.03, e: 0.017, omega: 0, meanAnomaly0: 0.05, epochSec: 0 };
    const st = orbitToState(orbit, 1);
    const snap: FactionSnapshot = {
      tick: 10,
      gameTimeSec: 1,
      faction: 'earth',
      resources: { ore: 300, propellant: 200 },
      freighterCap: 3,
      freightersInFlight: 0,
      celestials: SOLAR_SYSTEM_BODIES.map((b) => ({
        id: b.id,
        pos: b.orbit ? orbitToState(b.orbit, 1).pos : { x: 0, y: 0 },
        vel: b.orbit ? orbitToState(b.orbit, 1).vel : { x: 0, y: 0 },
      })),
      ownUnits: [
        {
          id: 'earth-recon-1',
          faction: 'earth',
          kind: 'recon_corvette',
          propulsion: 'electric',
          pos: st.pos,
          vel: st.vel,
          orbit,
          hp: 180,
          maxHp: 180,
          subsystems: { propulsion: 'normal', sensors: 'normal', weapons: 'normal', thermal: 'normal' },
          deltaV: 0.032,
          maxDeltaV: 0.032,
          heat: 95,
          maxHeat: 110,
          radiatorsOpen: true,
          emconSilent: false,
          radarActive: false,
          jammerActive: false,
          ammoStock: 4,
          plannedBurns: [],
        },
      ],
      ownMunitions: [],
      tracks: [],
      routes: [],
      ownWonder: [],
      enemyWonderPublicProgress: 0,
      vfxEvents: [],
      winner: null,
    };
    sock.emitServer({ type: 'snapshot', snapshot: snap });

    const initialVm = buildUnitControlViewModel(wsProvider.getSnapshot(), 'earth-recon-1')!;
    expect(initialVm.heatLevel).toBe('critical');
    expect(initialVm.heatPercent).toBe(86);

    const emconPromise = controller.toggleEmconSilent('earth-recon-1');
    const emconCmd = sock.sent.find(
      (m): m is Extract<ClientMessage, { type: 'command' }> =>
        m.type === 'command' && m.command.type === 'set_emcon',
    )!;
    expect(emconCmd.command).toEqual({
      type: 'set_emcon',
      unitId: 'earth-recon-1',
      silent: true,
      radiatorsOpen: false,
      radarActive: false,
      jammerActive: false,
    });
    sock.emitServer({ type: 'command_ack', clientSeq: emconCmd.clientSeq, accepted: true });
    expect(await emconPromise).toEqual({ accepted: true });

    const ladarPromise = controller.setLadarAngleDeg('earth-recon-1', 180);
    const ladarCmd = sock.sent.find(
      (m): m is Extract<ClientMessage, { type: 'command' }> =>
        m.type === 'command' && m.command.type === 'set_ladar',
    )!;
    expect(ladarCmd.command).toMatchObject({ type: 'set_ladar', unitId: 'earth-recon-1' });
    expect(
      (ladarCmd.command as Extract<typeof ladarCmd.command, { type: 'set_ladar' }>).angleRad,
    ).toBeCloseTo(Math.PI, 10);
    sock.emitServer({ type: 'command_ack', clientSeq: ladarCmd.clientSeq, accepted: true });
    expect(await ladarPromise).toEqual({ accepted: true });

    const dronePromise = controller.launchDrone('earth-recon-1', 'drone_ew');
    const droneCmd = sock.sent.find(
      (m): m is Extract<ClientMessage, { type: 'command' }> =>
        m.type === 'command' && m.command.type === 'launch_drone',
    )!;
    expect(droneCmd.command).toEqual({
      type: 'launch_drone',
      unitId: 'earth-recon-1',
      droneKind: 'drone_ew',
    });
    sock.emitServer({ type: 'command_ack', clientSeq: droneCmd.clientSeq, accepted: true });
    expect(await dronePromise).toEqual({ accepted: true });

    wsProvider.dispose();
  });
});
