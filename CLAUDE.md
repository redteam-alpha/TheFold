# CLAUDE.md — working on The Fold

The Fold is an AGPL-3.0 church CRM + community network built on **unmodified Twenty CRM** (ADR 0001).
Read `README.md`, `docs/adr/`, `docs/privacy-and-safety.md` and `docs/verification-status.md` first.

## Commands

```sh
pnpm install
pnpm check                 # SPDX headers + lint + typecheck + tests (what CI runs)
pnpm lint | pnpm typecheck | pnpm test
scripts/dev-pg.sh start    # ephemeral Postgres 16 for DB tests; prints env vars to export
```

## Layout

- `packages/core` — **dependency-free** domain rules (drift, welcomer, escalation, identity, prayer visibility,
  digests). Relative imports only (enforced by ESLint). Dates are `YYYY-MM-DD` calendar days.
- `packages/shared` — zod contracts and the `universalIdentifier` registry for the Twenty app.
- `packages/twenty-client` — the only code that talks to Twenty's API (rate limit, batching, backoff, HMAC).
- `apps/community-api` — SQL migrations with row-level security, outbox/inbox, workers.
- `apps/fold-app` — the Twenty app definitions (objects, fields, views, roles).

## Rules that are not negotiable

1. **Never copy OSSN code** (CAL-1.0, incompatible with AGPL) and never use files marked
   `@license Enterprise` from Twenty. Design from behaviour.
2. **No prayer/care free text in Twenty.** It lives in community-api (ADR 0004).
3. **Every source file starts with** `// SPDX-License-Identifier: AGPL-3.0-or-later` (`pnpm check:spdx`).
4. **Every tenant table has `tenant_id` + row-level security.** A schema test fails otherwise.
5. **No scores, rankings, leaderboards or peer-visible "who's missing".** See docs/privacy-and-safety.md.
6. **Nothing automated pretends to be personal.** Drift creates a task for a human; it never messages the person.
7. Never put real congregants' data in tests, fixtures or screenshots.
8. Claims about Twenty stay **UNVERIFIED** in `docs/verification-status.md` until run against a real instance.

## Style

TypeScript strict, ESM, named exports, `type` imports (`verbatimModuleSyntax`), no `any`, small pure
functions with property tests for anything that decides how a person is treated. Comment the *why*
(especially safety/privacy reasoning), not the what.
