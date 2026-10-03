# Twenty as a base: findings

Research date: 2026-09-30. **Method and limits:** `docs.twenty.com`, `twenty.com`, `gnu.org` and some
other hosts were blocked, so documentation was read from the repo itself
(`packages/twenty-docs/**`) via `raw.githubusercontent.com`. Page summaries were produced by a small
model; treat anything not marked verbatim as a summary. Nothing here is legal advice. The state of
every assumption is tracked in [`../verification-status.md`](../verification-status.md).

## 1. License

- `LICENSE` (custom; the GitHub API reports `NOASSERTION`): mostly **AGPL-3.0**.
  - **Commercial carve-out.** Files starting `/* @license Enterprise */` are under "The Twenty.com
    Commercial License": production use requires an Enterprise subscription. Example:
    `packages/twenty-server/src/engine/core-modules/enterprise/*`. Keys are checked by offline JWT
    plus online refresh (`ENTERPRISE_KEY`, `ENTERPRISE_VALIDITY_TOKEN`, `ENTERPRISE_API_URL`).
    [PR #26449](https://github.com/twentyhq/twenty/pull/26449) says `isValid()` gates SSO sign-in,
    row-level permissions, event logs, email group access and custom AI providers. The complete
    list of marked files was not enumerated (UNVERIFIED).
  - **MIT.** `twenty-sdk`, `twenty-client-sdk`, `create-twenty-app`, `twenty-shared`, `twenty-ui`
    and `packages/twenty-apps`.
  - **Application Exception** (AGPL §7 additional permission): software that uses the published
    REST/GraphQL APIs, webhooks, app manifest formats, logic functions, front components and SDKs and
    does not otherwise incorporate or modify Twenty's source "may be licensed under terms of your
    choice, including proprietary terms". If you **modify Twenty**, AGPL §13 applies to your modified
    version in full.
  - `.github/CLA.md` and `.github/TRADEMARK.md`: forks need their own name; "we host Twenty for our
    clients" is allowed as a truthful statement; implying an official offering needs permission.
- GPL-3.0 and AGPL-3.0 works may be combined (AGPL §13 ¶2); the reciprocal wording in GPLv3 was recalled
  from memory because gnu.org was blocked (UNVERIFIED).
- Per-seat pricing figures conflict across third-party snippets (UNVERIFIED).

## 2. Layout and stack (from `package.json` files)

- Node `^24.5.0`, Yarn 4 (`yarn@4.13.0`), Nx 22.x. Server: NestJS 11, TypeORM 0.3 (patched), GraphQL
  Yoga, BullMQ 5, Postgres 16 (15+ required), Redis. Front: React 19, Jotai, Apollo Client 4, Linaria,
  Lingui, React Router 7, Vite, Storybook.
- `packages/`: `create-twenty-app`, `twenty-apps`, `twenty-client-sdk`, `twenty-docker`, `twenty-docs`,
  `twenty-e2e-testing`, `twenty-emails`, `twenty-front`, `twenty-sdk`, `twenty-server`, `twenty-shared`,
  `twenty-ui`, `twenty-website`, and others.
- Self-host (`packages/twenty-docker/docker-compose.yml`): `server` (port 3000, `/healthz`), `worker`,
  `postgres:16`, `redis`. Required env: `SERVER_URL`, `PG_DATABASE_URL`, `REDIS_URL`, `ENCRYPTION_KEY`
  (losing it loses all stored secrets), `STORAGE_TYPE`. Optional: `IS_MULTIWORKSPACE_ENABLED`,
  `DEFAULT_SUBDOMAIN`, SMTP, OAuth, messaging/calendar providers.
- **`LOGIC_FUNCTION_TYPE` (`LOCAL|LAMBDA|DISABLED`) and `CODE_INTERPRETER_TYPE` default to `DISABLED` in
  production; `LOCAL` has no sandbox.** Logic functions and workflow Code steps depend on them.
  ⇒ The Fold does not use logic functions (ADR 0001 consequences).

## 3. Data model extensibility

- A metadata engine describes each workspace's objects/fields; the server generates a GraphQL schema
  and REST endpoints per workspace at runtime. Custom objects "immediately get REST and GraphQL
  endpoints identical to built-in objects", plus views, permissions and workflow triggers.
- Field types: TEXT, RICH_TEXT, NUMBER, DATE, DATE_TIME, BOOLEAN, SELECT, MULTI_SELECT, FULL_NAME,
  ADDRESS, EMAILS, PHONES, LINKS, CURRENCY, ACTOR, FILES, RELATION, MORPH_RELATION and more.
  Relations: MANY_TO_ONE / ONE_TO_MANY; many-to-many through a junction object. Every entity needs a
  stable `universalIdentifier` UUID. `defineField` with `objectUniversalIdentifier` can add fields to
  objects we do not own (e.g. Person) — **whether this works on Person is a checked M0 item.**
- Views: table, list, kanban, calendar; a view appears in the sidebar only with a navigation item.

## 4. Apps framework, automation, APIs

- `npx create-twenty-app`; `yarn twenty dev`. `twenty-sdk` v2.43.0 requires Twenty ≥ 2.40.0 and pins
  `twenty-client-sdk` at the same version. **Breaking changes shipped in minor SDK versions** (2.35,
  2.40, 2.42, 2.43) ⇒ pin everything together.
- An app can define: Application (exactly one), Role, Object, Field, Relation, Logic Function, Skill,
  Agent, View, Navigation Menu Item, Page Layout, Front Component, Command/Settings menu items, health
  checks, application variables. A post-install logic function can seed data.
- Workflows: triggers (record created/updated/deleted, manual, cron in UTC, webhook); actions (CRUD
  records, iterator, filter, delay, send email, form, code, HTTP request, AI agent, if/else).
- APIs: `/rest`, `/graphql`, `/metadata`; API keys (bearer, may carry a role); OAuth 2.0 provider
  (auth code + PKCE, client credentials); HMAC-SHA256-signed webhooks for all objects including custom
  (`X-Twenty-Webhook-Signature`, `X-Twenty-Webhook-Timestamp`); batch limit 60 records; cloud rate
  limit documented at 100 requests/minute (self-host UNVERIFIED).
- Email/calendar sync (Google, Microsoft, IMAP/SMTP/CalDAV) about every 5 minutes.
- Marketplace tab and email campaigns are labelled beta.

## 5. Tenancy, auth, permissions, portal

- Multi-workspace: `IS_MULTIWORKSPACE_ENABLED=true` (subdomains). Licensing/gating UNVERIFIED.
- Auth: email/password, Google, Microsoft. **SAML/SSO is Organization-plan gated.**
- Permissions: custom roles with object-level (see/edit/delete/destroy) and field-level permissions
  (not gated). **Row-level permissions are Organization-plan gated.** Record sharing exists behind
  `IS_RECORD_SHARING_ENABLED` (off; design still in flux).
- **No public form builder and no member portal.** Twenty users are workspace staff (seats).
  Recommended pattern: a separate service calling Twenty server-side with a scoped API key.

## 6. Gaps for a church

No households, attendance/check-in, giving, groups with roles, event registration, care cases, member
portal, or SMS/push/in-app messaging. `calendarEvent` is synced Google/Microsoft events only.

## 7. Cadence and contribution

Very active (commits daily; releases `twenty/vX.Y.Z` and `sdk/vX.Y.Z` roughly weekly; v2.43.0 on
2026-09-28). Style: named exports, functional components, `type` over `interface`, no `any`,
kebab-case files. Tests: Jest, Vitest, Playwright, Storybook. CLA required for contributions.
