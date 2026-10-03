// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import { kekFromEnv } from './crypto/envelope.js';
import type { SmtpSettings } from './mail/mailer.js';

type Env = Record<string, string | undefined>;

const flag = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const subdomain = z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, 'a lowercase DNS label');
const pgUrl = z
  .string()
  .regex(/^postgres(ql)?:\/\//, 'a postgres:// connection URL')
  .refine((s) => URL.canParse(s), 'a valid URL');

const dbParts = {
  /** Instead of a URL: the parts, from which the URL is built with the password encoded (see pgUrlFrom). */
  FOLD_DB_HOST: z.string().min(1).optional(),
  FOLD_DB_PORT: int(1, 65535).default(5432),
  FOLD_DB_NAME: z.string().min(1).default('community'),
};

/**
 * Builds a Postgres URL with the user and password percent-encoded. Generated passwords (`openssl rand -base64`)
 * contain `/`, `+` and `=`; pasted raw into `postgres://user:PASSWORD@host`, a `/` ends the host part and the
 * URL silently means something else, or nothing.
 */
export function pgUrlFrom(p: {
  user: string;
  password: string;
  host: string;
  port: number;
  database: string;
}): string {
  const u = new URL('postgres://placeholder');
  u.hostname = p.host;
  u.port = String(p.port);
  u.username = encodeURIComponent(p.user);
  u.password = encodeURIComponent(p.password);
  u.pathname = `/${encodeURIComponent(p.database)}`;
  return u.toString();
}

/** What the API and the worker need. Read once at start-up; a bad value stops the process with a clear message. */
const serviceSchema = z
  .object({
    /** Connects as `fold_app`: no ownership, no BYPASSRLS. Never the migrator or a superuser. */
    FOLD_DATABASE_URL: pgUrl.optional(),
    ...dbParts,
    FOLD_APP_DB_PASSWORD: z.string().min(1).optional(),
    FOLD_HTTP_HOST: z.string().default('0.0.0.0'),
    FOLD_HTTP_PORT: int(1, 65535).default(4000),
    /** e.g. `thefold.app`: `grace.thefold.app` is the church with subdomain `grace`. */
    FOLD_BASE_DOMAIN: z
      .string()
      .regex(/^[a-z0-9.-]+$/)
      .optional(),
    /** The church to use when the Host is not under FOLD_BASE_DOMAIN (a single-church or development install). */
    FOLD_DEFAULT_SUBDOMAIN: subdomain.optional(),
    /** Only behind a proxy you control: otherwise anyone can claim any client IP and dodge the rate limit. */
    FOLD_TRUST_PROXY: flag.default(false),
    /** Cloudflare Turnstile secret. Unset: no captcha check (the honeypot and rate limit still apply). */
    FOLD_TURNSTILE_SECRET: z.string().min(1).optional(),
    /** Connection cards accepted per client IP per 10 minutes. A family filling in cards on one phone needs a few. */
    FOLD_CARD_RATE_LIMIT: int(1, 1000).default(10),
    /** Sign-in requests accepted per client IP per 10 minutes. */
    FOLD_SIGNIN_RATE_LIMIT: int(1, 1000).default(10),
    /** Member email (sign-in links). Unset: sign-in is switched off and says so. */
    FOLD_SMTP_HOST: z.string().min(1).optional(),
    FOLD_SMTP_PORT: int(1, 65535).default(587),
    /** Implicit TLS (port 465). Otherwise STARTTLS is used when the server offers it. */
    FOLD_SMTP_SECURE: flag.default(false),
    FOLD_SMTP_USER: z.string().min(1).optional(),
    FOLD_SMTP_PASSWORD: z.string().min(1).optional(),
    /** e.g. `"Grace Church via The Fold" <no-reply@thefold.app>` */
    FOLD_MAIL_FROM: z.string().min(3).optional(),
    /**
     * The address members use, for links in email. May contain `{subdomain}`, e.g. `https://{subdomain}.thefold.app`.
     * Default: `https://{subdomain}.<FOLD_BASE_DOMAIN>`. An `https` address also makes session cookies `Secure`.
     */
    FOLD_PUBLIC_URL: z
      .string()
      .regex(
        /^https?:\/\/[^\s/]+(\/[^\s]*)?$/,
        'an http(s) address, e.g. https://{subdomain}.thefold.app',
      )
      .optional(),
    FOLD_WORKER_POLL_MS: int(250, 600_000).default(5000),
    FOLD_RECONCILE_MINUTES: int(1, 24 * 60).default(60),
    FOLD_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  })
  .refine((c) => c.FOLD_DATABASE_URL || (c.FOLD_DB_HOST && c.FOLD_APP_DB_PASSWORD), {
    path: ['FOLD_DATABASE_URL'],
    message:
      'set FOLD_DATABASE_URL, or FOLD_DB_HOST with FOLD_APP_DB_PASSWORD (and FOLD_DB_PORT, FOLD_DB_NAME)',
  })
  .refine((c) => !c.FOLD_SMTP_HOST || c.FOLD_MAIL_FROM, {
    path: ['FOLD_MAIL_FROM'],
    message: 'required with FOLD_SMTP_HOST (the From address of member email)',
  })
  .refine((c) => !c.FOLD_SMTP_HOST || c.FOLD_PUBLIC_URL || c.FOLD_BASE_DOMAIN, {
    path: ['FOLD_PUBLIC_URL'],
    message:
      'required with FOLD_SMTP_HOST unless FOLD_BASE_DOMAIN is set (links in email need an address)',
  });

export interface ServiceConfig {
  databaseUrl: string;
  http: { host: string; port: number };
  tenancy: { baseDomain: string | null; defaultSubdomain: string | null };
  trustProxy: boolean;
  turnstileSecret: string | null;
  cardRateLimit: number;
  worker: { pollMs: number; reconcileEveryMs: number };
  /** Member email and sign-in. Null when FOLD_SMTP_HOST is unset: sign-in is switched off. */
  mail: {
    smtp: SmtpSettings;
    /** With `{subdomain}` where the church's subdomain goes. */
    publicUrl: string;
    signInRateLimit: number;
  } | null;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Key-encryption key for tenant secrets and care text (ADR 0004). Held only in memory. */
  kek: Buffer;
}

export class ConfigError extends Error {
  constructor(problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/** The church's public address from a `FOLD_PUBLIC_URL` template. */
export const publicUrlFor = (template: string, subdomain: string): string =>
  template.replaceAll('{subdomain}', subdomain);

/** Names the variable and the rule, never the value: a value may be a secret. */
function problemsOf(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`);
}

const blankToUndefined = (env: Env): Env =>
  Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v === '' ? undefined : v]));

export function loadServiceConfig(env: Env = process.env): ServiceConfig {
  const parsed = serviceSchema.safeParse(blankToUndefined(env));
  const problems = parsed.success ? [] : problemsOf(parsed.error);
  let kek: Buffer | null = null;
  try {
    kek = kekFromEnv(env);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : 'FOLD_KEK is invalid');
  }
  if (!parsed.success || !kek) throw new ConfigError(problems);
  const c = parsed.data;
  return {
    databaseUrl:
      c.FOLD_DATABASE_URL ??
      pgUrlFrom({
        user: 'fold_app',
        password: c.FOLD_APP_DB_PASSWORD as string,
        host: c.FOLD_DB_HOST as string,
        port: c.FOLD_DB_PORT,
        database: c.FOLD_DB_NAME,
      }),
    http: { host: c.FOLD_HTTP_HOST, port: c.FOLD_HTTP_PORT },
    tenancy: {
      baseDomain: c.FOLD_BASE_DOMAIN ?? null,
      defaultSubdomain: c.FOLD_DEFAULT_SUBDOMAIN ?? null,
    },
    trustProxy: c.FOLD_TRUST_PROXY,
    turnstileSecret: c.FOLD_TURNSTILE_SECRET ?? null,
    cardRateLimit: c.FOLD_CARD_RATE_LIMIT,
    worker: { pollMs: c.FOLD_WORKER_POLL_MS, reconcileEveryMs: c.FOLD_RECONCILE_MINUTES * 60_000 },
    mail: c.FOLD_SMTP_HOST
      ? {
          smtp: {
            host: c.FOLD_SMTP_HOST,
            port: c.FOLD_SMTP_PORT,
            secure: c.FOLD_SMTP_SECURE,
            user: c.FOLD_SMTP_USER ?? null,
            password: c.FOLD_SMTP_PASSWORD ?? null,
            from: c.FOLD_MAIL_FROM as string,
          },
          publicUrl: (
            c.FOLD_PUBLIC_URL ?? `https://{subdomain}.${c.FOLD_BASE_DOMAIN as string}`
          ).replace(/\/+$/, ''),
          signInRateLimit: c.FOLD_SIGNIN_RATE_LIMIT,
        }
      : null,
    logLevel: c.FOLD_LOG_LEVEL,
    kek,
  };
}

/** What `setup` needs: database bootstrap and migration, plus (optionally) the first church. */
const setupSchema = z
  .object({
    /** Optional: a superuser URL, used only to create the roles, set their passwords and hand the database to the migrator. */
    FOLD_DB_SUPERUSER_URL: pgUrl.optional(),
    FOLD_MIGRATOR_DATABASE_URL: pgUrl.optional(),
    ...dbParts,
    FOLD_DB_SUPERUSER: z.string().min(1).default('postgres'),
    FOLD_DB_SUPERUSER_PASSWORD: z.string().min(1).optional(),
    FOLD_MIGRATOR_DB_PASSWORD: z.string().min(12).optional(),
    FOLD_APP_DB_PASSWORD: z.string().min(12).optional(),
    FOLD_TENANT_SLUG: subdomain.optional(),
    FOLD_TENANT_NAME: z.string().min(1).max(200).optional(),
    FOLD_TENANT_SUBDOMAIN: subdomain.optional(),
    FOLD_TENANT_TIMEZONE: z
      .string()
      .refine((tz) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      }, 'an IANA time zone such as America/Chicago')
      .default('UTC'),
    /** Where the worker reaches Twenty, e.g. `http://twenty-server:3000` inside the compose network. */
    FOLD_TWENTY_BASE_URL: z
      .string()
      .refine((s) => URL.canParse(s) && /^https?:$/.test(new URL(s).protocol), 'an http(s) URL')
      .optional(),
    /** The key with the "The Fold service account" role (infra/README.md step 2). */
    FOLD_TWENTY_API_KEY: z.string().min(20).optional(),
    FOLD_TWENTY_WEBHOOK_SECRET: z.string().min(16).optional(),
  })
  .superRefine((c, ctx) => {
    if (!c.FOLD_MIGRATOR_DATABASE_URL && !(c.FOLD_DB_HOST && c.FOLD_MIGRATOR_DB_PASSWORD))
      ctx.addIssue({
        code: 'custom',
        path: ['FOLD_MIGRATOR_DATABASE_URL'],
        message: 'set FOLD_MIGRATOR_DATABASE_URL, or FOLD_DB_HOST with FOLD_MIGRATOR_DB_PASSWORD',
      });
    // A church is wanted when its slug or its key is given; the base URL alone (compose sets a default) is not enough.
    const wanted = Boolean(c.FOLD_TENANT_SLUG || c.FOLD_TWENTY_API_KEY);
    const tenant = [c.FOLD_TENANT_SLUG, c.FOLD_TWENTY_BASE_URL, c.FOLD_TWENTY_API_KEY];
    if (wanted && !tenant.every(Boolean))
      ctx.addIssue({
        code: 'custom',
        path: ['FOLD_TENANT_SLUG'],
        message:
          'to provision a church set all of FOLD_TENANT_SLUG, FOLD_TWENTY_BASE_URL and FOLD_TWENTY_API_KEY (or none)',
      });
    const bootstrapping =
      c.FOLD_DB_SUPERUSER_URL || (c.FOLD_DB_HOST && c.FOLD_DB_SUPERUSER_PASSWORD);
    if (bootstrapping && (!c.FOLD_APP_DB_PASSWORD || !c.FOLD_MIGRATOR_DB_PASSWORD))
      ctx.addIssue({
        code: 'custom',
        path: ['FOLD_APP_DB_PASSWORD'],
        message:
          'bootstrapping as a superuser also needs FOLD_APP_DB_PASSWORD and FOLD_MIGRATOR_DB_PASSWORD',
      });
  });

export interface TenantProvisioning {
  slug: string;
  name: string;
  subdomain: string;
  timezone: string;
  twentyBaseUrl: string;
  twentyApiKey: string;
  twentyWebhookSecret: string | null;
}

export interface SetupConfig {
  superuserUrl: string | null;
  migratorUrl: string;
  rolePasswords: { app: string; migrator: string } | null;
  tenant: TenantProvisioning | null;
  /** Needed only when a tenant is provisioned (its secrets are stored wrapped). */
  kek: Buffer | null;
}

export function loadSetupConfig(env: Env = process.env): SetupConfig {
  const parsed = setupSchema.safeParse(blankToUndefined(env));
  if (!parsed.success) throw new ConfigError(problemsOf(parsed.error));
  const c = parsed.data;
  const tenant: TenantProvisioning | null =
    c.FOLD_TENANT_SLUG && c.FOLD_TWENTY_BASE_URL && c.FOLD_TWENTY_API_KEY
      ? {
          slug: c.FOLD_TENANT_SLUG,
          name: c.FOLD_TENANT_NAME ?? c.FOLD_TENANT_SLUG,
          subdomain: c.FOLD_TENANT_SUBDOMAIN ?? c.FOLD_TENANT_SLUG,
          timezone: c.FOLD_TENANT_TIMEZONE,
          twentyBaseUrl: new URL(c.FOLD_TWENTY_BASE_URL).origin,
          twentyApiKey: c.FOLD_TWENTY_API_KEY,
          twentyWebhookSecret: c.FOLD_TWENTY_WEBHOOK_SECRET ?? null,
        }
      : null;
  let kek: Buffer | null = null;
  if (tenant) {
    try {
      kek = kekFromEnv(env);
    } catch (error) {
      throw new ConfigError([error instanceof Error ? error.message : 'FOLD_KEK is invalid']);
    }
  }
  const fromParts = (user: string, password: string | undefined) =>
    c.FOLD_DB_HOST && password
      ? pgUrlFrom({
          user,
          password,
          host: c.FOLD_DB_HOST,
          port: c.FOLD_DB_PORT,
          database: c.FOLD_DB_NAME,
        })
      : null;
  return {
    superuserUrl:
      c.FOLD_DB_SUPERUSER_URL ?? fromParts(c.FOLD_DB_SUPERUSER, c.FOLD_DB_SUPERUSER_PASSWORD),
    migratorUrl:
      c.FOLD_MIGRATOR_DATABASE_URL ??
      (fromParts('fold_migrator', c.FOLD_MIGRATOR_DB_PASSWORD) as string),
    rolePasswords:
      c.FOLD_APP_DB_PASSWORD && c.FOLD_MIGRATOR_DB_PASSWORD
        ? { app: c.FOLD_APP_DB_PASSWORD, migrator: c.FOLD_MIGRATOR_DB_PASSWORD }
        : null,
    tenant,
    kek,
  };
}
