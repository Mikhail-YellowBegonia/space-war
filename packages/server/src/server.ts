import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION, SIM_TICK_RATE_HZ, type ServerMessage } from '@space-war/shared';
import { WebSocket, WebSocketServer } from 'ws';
import { RoomManager, type ClientConnection, type RoomManagerOptions } from './net/roomManager.js';

export const DEFAULT_PORT = 3001;
export const DEFAULT_LIVE_TIME_SCALE = 0.5;

const CLIENT_DIST_DIR = fileURLToPath(new URL('../../client/dist', import.meta.url));

const STATIC_MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export interface HealthPayload {
  status: 'ok';
  service: 'space-war-server';
  protocolVersion: string;
  tickRateHz: number;
}

export interface SpaceWarServerOptions {
  port?: number;
  host?: string;
  roomManagerOptions?: RoomManagerOptions;
}

export interface SpaceWarServer {
  roomManager: RoomManager;
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

function sendStaticFile(
  res: ServerResponse,
  filePath: string,
  method: string,
): boolean {
  try {
    if (!statSync(filePath).isFile()) {
      return false;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = STATIC_MIME_TYPES[ext] ?? 'application/octet-stream';
    const body = readFileSync(filePath);
    res.writeHead(200, {
      'content-type': contentType,
      'content-length': body.byteLength,
    });
    res.end(method === 'HEAD' ? undefined : body);
    return true;
  } catch {
    return false;
  }
}

function handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
  const method = req.method ?? 'GET';
  const rawPath = (req.url ?? '/').split('?')[0] ?? '/';
  if ((method === 'GET' || method === 'HEAD') && rawPath === '/health') {
    const payload = JSON.stringify(getHealthPayload());
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(method === 'HEAD' ? undefined : payload);
    return;
  }

  if ((method === 'GET' || method === 'HEAD') && rawPath !== '/ws' && existsSync(CLIENT_DIST_DIR)) {
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(rawPath);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(method === 'HEAD' ? undefined : JSON.stringify({ error: 'Bad Request' }));
      return;
    }

    const indexPath = path.join(CLIENT_DIST_DIR, 'index.html');
    if (decodedPath === '/' || decodedPath === '/index.html') {
      if (sendStaticFile(res, indexPath, method)) {
        return;
      }
    } else {
      const relPath = decodedPath.replace(/^\/+/, '');
      const resolved = path.resolve(CLIENT_DIST_DIR, relPath);
      const isInsideDist = resolved.startsWith(CLIENT_DIST_DIR + path.sep);
      if (isInsideDist && sendStaticFile(res, resolved, method)) {
        return;
      }
      if (!path.extname(decodedPath) && sendStaticFile(res, indexPath, method)) {
        return;
      }
    }
  }

  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  res.end(method === 'HEAD' ? undefined : JSON.stringify({ error: 'Not Found' }));
}

/**
 * Creates the Space War HTTP + WebSocket server without binding a listening socket until `start()`.
 */
export function createSpaceWarServer(options: SpaceWarServerOptions = {}): SpaceWarServer {
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? '127.0.0.1';

  const autoStartLoop = options.roomManagerOptions?.autoStartLoop ?? true;
  const timeScale =
    options.roomManagerOptions?.timeScale ??
    (autoStartLoop ? DEFAULT_LIVE_TIME_SCALE : 1.0);

  const roomManager = new RoomManager({
    ...options.roomManagerOptions,
    autoStartLoop,
    timeScale,
  });

  const httpServer = createServer(handleHttpRequest);
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (socket) => {
    const conn: ClientConnection = {
      id: randomUUID(),
      send: (message: ServerMessage) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(message));
        }
      },
    };

    roomManager.handleConnect(conn);

    socket.on('message', (data) => {
      const text = typeof data === 'string' ? data : data.toString('utf8');
      roomManager.handleMessage(conn, text);
    });

    socket.on('close', () => {
      roomManager.handleDisconnect(conn);
    });
  });

  return {
    roomManager,
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
        roomManager.stopAll();
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
