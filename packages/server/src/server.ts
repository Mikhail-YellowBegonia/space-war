import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PROTOCOL_VERSION, SIM_TICK_RATE_HZ } from '@space-war/shared';
import { WebSocketServer } from 'ws';

export const DEFAULT_PORT = 3001;

export interface HealthPayload {
  status: 'ok';
  service: 'space-war-server';
  protocolVersion: string;
  tickRateHz: number;
}

export interface SpaceWarServerOptions {
  port?: number;
  host?: string;
}

export interface SpaceWarServer {
  start: () => Promise<{ host: string; port: number }>;
  close: () => Promise<void>;
}

/**
 * Returns the static server health check payload aligned with shared protocol constants.
 */
export function getHealthPayload(): HealthPayload {
  return {
    status: 'ok',
    service: 'space-war-server',
    protocolVersion: PROTOCOL_VERSION,
    tickRateHz: SIM_TICK_RATE_HZ,
  };
}

function handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
  const urlPath = (req.url ?? '/').split('?')[0];
  if (req.method === 'GET' && urlPath === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(getHealthPayload()));
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'Not Found' }));
}

/**
 * Creates the Space War HTTP + WebSocket server without binding a listening socket until `start()`.
 */
export function createSpaceWarServer(options: SpaceWarServerOptions = {}): SpaceWarServer {
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? '127.0.0.1';

  const httpServer = createServer(handleHttpRequest);
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (socket) => {
    socket.send(
      JSON.stringify({
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
      }),
    );
  });

  return {
    start: () =>
      new Promise((resolve, reject) => {
        const onError = (err: Error) => {
          httpServer.off('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          httpServer.off('error', onError);
          const address = httpServer.address() as AddressInfo | null;
          resolve({
            host,
            port: address?.port ?? port,
          });
        };

        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        httpServer.listen(port, host);
      }),

    close: () =>
      new Promise((resolve, reject) => {
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close(() => {
          if (!httpServer.listening) {
            resolve();
            return;
          }
          httpServer.close((err) => {
            if (err) {
              reject(err);
              return;
            }
            resolve();
          });
        });
      }),
  };
}
