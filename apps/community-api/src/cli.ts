// SPDX-License-Identifier: AGPL-3.0-or-later
import { serve } from '@hono/node-server';
import { Pool } from 'pg';
import { ConfigError, loadServiceConfig, loadSetupConfig } from './config.js';
import { buildApi } from './http/app.js';
import { createLogger, errorFields, type Logger } from './log.js';
import { runSetup } from './setup/setup.js';
import { TwentyConnections } from './tenants/runtime.js';
import { Worker } from './workers/loop.js';

export const USAGE = `usage: community-api <command>

  api      serve the HTTP API (FOLD_DATABASE_URL, FOLD_KEK, ...)
  worker   run the background worker (same settings as api)
  setup    bootstrap roles, migrate, and provision the first church (FOLD_MIGRATOR_DATABASE_URL, ...)

Settings are environment variables; see infra/README.md ("The community service").`;

function appPool(url: string, log: Logger, max: number): Pool {
  const pool = new Pool({ connectionString: url, max });
  // An idle client losing its connection must not crash the process; the next query reconnects.
  pool.on('error', (error) => log.warn('db.idle_client_error', errorFields(error)));
  return pool;
}

/** Resolves when the process receives SIGTERM or SIGINT (docker stop, Ctrl-C). */
function onShutdown(): AbortSignal {
  const controller = new AbortController();
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => controller.abort());
  return controller.signal;
}

async function api(): Promise<void> {
  const cfg = loadServiceConfig();
  const log = createLogger(cfg.logLevel);
  const pool = appPool(cfg.databaseUrl, log, 10);
  const app = buildApi({
    pool,
    kek: cfg.kek,
    log,
    tenancy: cfg.tenancy,
    trustProxy: cfg.trustProxy,
    turnstileSecret: cfg.turnstileSecret,
    cardRateLimit: cfg.cardRateLimit,
  });
  const server = serve({ fetch: app.fetch, hostname: cfg.http.host, port: cfg.http.port }, (info) =>
    log.info('api.listening', { host: info.address, port: info.port }),
  );
  const stop = onShutdown();
  await new Promise<void>((resolve) =>
    stop.addEventListener('abort', () => resolve(), { once: true }),
  );
  log.info('api.stopping');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
}

async function worker(): Promise<void> {
  const cfg = loadServiceConfig();
  const log = createLogger(cfg.logLevel);
  const pool = appPool(cfg.databaseUrl, log, 5);
  const w = new Worker({
    pool,
    twenty: new TwentyConnections(pool, cfg.kek),
    log,
    reconcileEveryMs: cfg.worker.reconcileEveryMs,
  });
  await w.run(cfg.worker.pollMs, onShutdown());
  await pool.end();
}

async function setup(): Promise<void> {
  const cfg = loadSetupConfig();
  await runSetup(cfg, createLogger('info'));
}

export async function runCli(argv: readonly string[]): Promise<number> {
  const command = argv[0];
  const commands: Record<string, () => Promise<void>> = { api, worker, setup };
  const run = command ? commands[command] : undefined;
  if (!run) {
    process.stderr.write(`${USAGE}\n`);
    return 64; // EX_USAGE
  }
  try {
    await run();
    return 0;
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      return 78; // EX_CONFIG
    }
    createLogger('error').error(`${command}.failed`, errorFields(error));
    return 1;
  }
}
