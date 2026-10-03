// SPDX-License-Identifier: AGPL-3.0-or-later
import { serve } from '@hono/node-server';
import { Pool } from 'pg';
import { STAFF_ROLES } from '@thefold/core';
import { ConfigError, loadServiceConfig, loadSetupConfig, publicUrlFor } from './config.js';
import { tenantIdForSubdomain, withTenant } from './db/tenant.js';
import { buildApi } from './http/app.js';
import { createLogger, errorFields, type Logger } from './log.js';
import { smtpMailer } from './mail/mailer.js';
import { grantStaffRole, isStaffRole, revokeStaffRole } from './portal/confirm.js';
import { runSetup } from './setup/setup.js';
import { TwentyConnections } from './tenants/runtime.js';
import { Worker } from './workers/loop.js';

export const USAGE = `usage: community-api <command>

  api      serve the HTTP API (FOLD_DATABASE_URL, FOLD_KEK, ...)
  worker   run the background worker (same settings as api)
  setup    bootstrap roles, migrate, and provision the first church (FOLD_MIGRATOR_DATABASE_URL, ...)
  grant-role  <subdomain> <twenty-person-id> <role>   give a person a staff role in the portal
  revoke-role <subdomain> <twenty-person-id> <role>   take it away again
              roles: ${STAFF_ROLES.join(', ')}

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
    portal: cfg.mail
      ? {
          secureCookies: cfg.mail.publicUrl.startsWith('https://'),
          signInRateLimit: cfg.mail.signInRateLimit,
        }
      : null,
  });
  if (!cfg.mail) log.warn('api.signin_disabled', { reason: 'FOLD_SMTP_HOST is not set' });
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
  const mail = cfg.mail;
  if (!mail) log.warn('worker.mail_disabled', { reason: 'FOLD_SMTP_HOST is not set' });
  const w = new Worker({
    pool,
    twenty: new TwentyConnections(pool, cfg.kek),
    log,
    reconcileEveryMs: cfg.worker.reconcileEveryMs,
    mail: mail
      ? {
          mailer: smtpMailer(mail.smtp),
          publicUrl: (subdomain) => publicUrlFor(mail.publicUrl, subdomain),
        }
      : null,
  });
  await w.run(cfg.worker.pollMs, onShutdown());
  await pool.end();
}

async function setup(): Promise<void> {
  const cfg = loadSetupConfig();
  await runSetup(cfg, createLogger('info'));
}

class UsageError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `grant-role` / `revoke-role`: the operator gives the first admin their role; admins are not self-appointed. */
function roleCommand(kind: 'grant' | 'revoke') {
  return async (args: readonly string[]): Promise<void> => {
    const [subdomain, personId, role] = args;
    if (!subdomain || !personId || !UUID.test(personId) || !role || !isStaffRole(role))
      throw new UsageError(
        `usage: community-api ${kind}-role <subdomain> <twenty-person-id> <role>\n  roles: ${STAFF_ROLES.join(', ')}`,
      );
    const cfg = loadServiceConfig();
    const pool = appPool(cfg.databaseUrl, createLogger(cfg.logLevel), 1);
    try {
      const tenantId = await tenantIdForSubdomain(pool, subdomain);
      if (!tenantId) throw new Error(`no active church with subdomain "${subdomain}"`);
      const outcome = await withTenant(pool, tenantId, (c) =>
        kind === 'grant'
          ? grantStaffRole(c, personId, role)
          : revokeStaffRole(c, personId, role, new Date()),
      );
      if (outcome === 'NO_SUCH_PERSON')
        throw new Error(
          'that person is not in the community database: check the id in Twenty, wait for the next sync, and that they are an adult',
        );
      process.stdout.write(`${outcome}: ${role} for ${personId} at ${subdomain}\n`);
    } finally {
      await pool.end();
    }
  };
}

export async function runCli(argv: readonly string[]): Promise<number> {
  const [command, ...args] = argv;
  const commands: Record<string, (args: readonly string[]) => Promise<void>> = {
    api,
    worker,
    setup,
    'grant-role': roleCommand('grant'),
    'revoke-role': roleCommand('revoke'),
  };
  const run = command ? commands[command] : undefined;
  if (!run) {
    process.stderr.write(`${USAGE}\n`);
    return 64; // EX_USAGE
  }
  try {
    await run(args);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      return 64;
    }
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      return 78; // EX_CONFIG
    }
    createLogger('error').error(`${command}.failed`, errorFields(error));
    return 1;
  }
}
