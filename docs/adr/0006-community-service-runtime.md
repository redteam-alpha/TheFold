# ADR 0006 — The community service runs on Hono and a Postgres-backed worker

- Status: accepted
- Date: 2026-10-02

## Decision

`apps/community-api` is one image with three commands (`src/cli.ts`):

- **`api`**: a small [Hono](https://hono.dev) app (MIT, no dependencies of its own) on Node, served by `@hono/node-server`.
- **`worker`**: a plain loop (`src/workers/loop.ts`) that visits each active church and drains the work the API queued.
- **`setup`**: database roles, migrations and church provisioning, idempotent.

The queue is the **Postgres outbox** that already existed (`outbox`, claimed with `FOR UPDATE SKIP LOCKED` and a lease), plus the
webhook inbox and the reconcile cursor. There is no Redis queue and no NestJS. The original plan named NestJS and BullMQ; this replaces
that.

## Why

- **One source of truth for "what still has to happen".** The outbox row is written in the same transaction as the change that needs
  it (a connection card, a welcome assignment). A Redis queue would be a second store that can disagree with the first after a crash,
  and would need its own outbox to be safe.
- **The work is small and bursty.** A church produces dozens of jobs a week. Polling every few seconds costs nothing, and several workers
  can run at once without coordination beyond SKIP LOCKED.
- **Fewer moving parts to license-check, patch and explain.** Two MIT packages (`hono`, `@hono/node-server`) with no transitive
  dependencies, against a framework plus a queue plus Redis.
- **Testable without a network.** Hono handles standard `Request`/`Response`, so the HTTP tests (`test/api.test.ts`) call
  `app.request()` against a real database with no port. The raw body, which the webhook signature needs, is one call away.
- **TypeScript source at runtime (tsx).** The workspace packages export `.ts`; running them with tsx means the image runs exactly the code
  the tests ran, with no separate build output to drift.

## Consequences

- Per-IP rate limiting on the public form is in memory, per API instance (`src/http/rateLimit.ts`): with N instances the limit is N
  times looser. Acceptable for a form behind a honeypot and an optional captcha; revisit if the API is scaled out.
- Request handling is hand-written: validation is zod (`@thefold/shared`), errors are JSON, logs are one JSON object per line with
  ids only (`src/log.ts`). When the portal's authenticated API arrives, it should stay in this style unless it outgrows it; that is the
  point to reconsider, not before.
- The worker never contacts a person (CLAUDE.md rule 6). Email delivery, when it comes, is a separate, consented flow.
