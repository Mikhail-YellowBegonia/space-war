import { createSpaceWarServer, DEFAULT_LIVE_TIME_SCALE, DEFAULT_PORT } from './server.js';

export * from './ai/index.js';
export * from './engine/index.js';
export * from './net/index.js';
export * from './systems/index.js';
export {
  createSpaceWarServer,
  DEFAULT_LIVE_TIME_SCALE,
  DEFAULT_PORT,
  getHealthPayload,
} from './server.js';
export type { HealthPayload, SpaceWarServer, SpaceWarServerOptions } from './server.js';

async function main(): Promise<void> {
  const parsedPort = Number(process.env.PORT);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT;
  const host = process.env.HOST ?? '127.0.0.1';
  const parsedScale = Number(process.env.TIME_SCALE);
  const timeScale =
    Number.isFinite(parsedScale) && parsedScale > 0 ? parsedScale : DEFAULT_LIVE_TIME_SCALE;

  const server = createSpaceWarServer({
    port,
    host,
    roomManagerOptions: { timeScale },
  });
  const bound = await server.start();
  console.log(
    `[space-war/server] listening on http://${bound.host}:${bound.port} (timeScale=${timeScale}x)`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`[space-war/server] received ${signal}, shutting down...`);
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('/src/index.ts') || process.argv[1].endsWith('/dist/index.js'));

if (isEntrypoint) {
  main().catch((err: unknown) => {
    console.error('[space-war/server] fatal startup error:', err);
    process.exit(1);
  });
}
