# Verification status

The single ledger of what has actually been checked, by what, and what is still an assumption.

**"Tested" here means the code does what it says. It does not mean an assumption about Twenty is true.**
Every row about a real Twenty instance stays ❓ until `pnpm m0` (see [`../infra/README.md`](../infra/README.md))
has been run against one and the result pasted at the bottom of this file.

Legend: ✅ verified · 🟡 verified against a stand-in only · ❓ UNVERIFIED (needs a real Twenty) · ❌ checked and wrong · ⏳ not built yet

Last full pass: 2026-09-30, Node 22.22, PostgreSQL 16.13, `twenty-sdk` 2.43.0. The sandbox had no Docker daemon
and Node 22 (the SDK asks for Node 24.5), so nothing here has run against a live Twenty.

## 1. Our own logic (no Twenty needed)

| Item | Status | Evidence |
|---|---|---|
| Drift: own-rhythm threshold, eligibility, cooldowns, exclusions, household union, per-shepherd cap, outcomes | ✅ | `packages/core/test/drift*.test.ts` — unit + fast-check properties (e.g. a flag always exceeds its own threshold; minors and do-not-contact are never flagged) |
| Tenant attendance health and church-wide break weeks | ✅ | `drift-population.test.ts` |
| Welcomer fairness, weights, `maxOpen`, determinism regardless of input order | ✅ | `assignment-and-followups.test.ts` (1000-arrival simulations, property tests) |
| Escalation timing (36h remind, 72h notify the welcome lead) | ✅ | same |
| Identity matching, portal linking, never auto-merging | ✅ | `identity-and-care.test.ts` |
| Prayer visibility and audit rules (`canViewPrayer`) | ✅ | same |
| Notification digests: quiet hours, daily cap, redaction, security exempt | ✅ | `digest.test.ts` |
| Contracts encode the safety rules (no default prayer tier, no public tier, contact method required, honeypot) | ✅ | `packages/shared/test/contracts.test.ts` |
| Deterministic UUIDs are valid v4 and match an independent implementation | ✅ | `identifiers.test.ts` cross-checks Python `hashlib` and `node:crypto` |
| The dependency-free boundary of `packages/core` | ✅ | ESLint `no-restricted-imports`; a probe file importing `node:fs` and `zod` was rejected |

## 2. Database behaviour (real PostgreSQL 16)

| Item | Status | Evidence |
|---|---|---|
| Every tenant table has `tenant_id`, ENABLE + FORCE row-level security and the `tenant_isolation` policy | ✅ | `apps/community-api/test/schema.test.ts` (scans the catalog; a new table that misses the helper fails) |
| Tenant A cannot read, insert, update, delete or re-home tenant B's rows; no context sees nothing | ✅ | `rls.test.ts`. **Mutation-checked**: weakening one policy to `USING (true)` made tenant A see tenant B's rows, so the tests can fail |
| Cross-table foreign keys always include `tenant_id`, so a row cannot reference another tenant | ✅ | schema lint + a composite-FK violation test |
| The tenant setting cannot leak to the next user of a pooled connection | ✅ | `rls.test.ts` (pool of one connection) |
| `fold_app` cannot bypass RLS, own tables, alter policies or run DDL | ✅ | `schema.test.ts` |
| Audit/consent/care-note tables are append-only for the app, and even the owner is blocked by trigger | ✅ | `schema.test.ts` (also found: with `FORCE` the owner sees no rows without a tenant context) |
| CHECK constraints stay in sync with the enums in `packages/core` | ✅ | `schema.test.ts` |
| Migration runner: order, checksum guard, rollback on failure, concurrent runners | ✅ | `migrate.test.ts` |
| Outbox: idempotent enqueue, `SKIP LOCKED` leasing, lease recovery, capped backoff, dead letters | ✅ | `outbox.test.ts` |
| Webhook inbox: dedupe, coalescing, no lost change during a refetch | ✅ | `inbox-and-readmodels.test.ts` |
| Read models apply only newer data (late/duplicate/out-of-order updates cannot roll back) | ✅ | same |
| Prayer text encrypted at rest, bound to its tenant/record; care-path reads and denials audited; text never in the Twenty-bound job | ✅ | `prayer.test.ts`, `envelope.test.ts` |

### The vertical slice (connection card → guest → welcomer → follow-ups), on real PostgreSQL

Wired together in `apps/community-api/src/{intake,workers,twenty}` and tested end to end with an in-memory Twenty that can fail on demand
(`test/welcome-slice.test.ts`) and, separately, the REST gateway against the fake Twenty (`test/rest-gateway.test.ts`).

| Behaviour | Status |
|---|---|
| A card becomes a guest, an attendance and three follow-ups (48h / 7d / 21d) with **one** owner | ✅ (🟡 for the Twenty side: shapes ❓ until M0) |
| A double-tapped Submit or refresh creates one guest, however the email is formatted | ✅ |
| Six guests spread evenly over three welcomers; capacity and "away" respected; nobody left ownerless (pool fallback is audited) | ✅ |
| A family is welcomed once through one person; children are minors, parent-managed, never contacted | ✅ |
| A guest who did not consent to contact is recorded but no one is asked to call | ✅ |
| A known member is attached, not duplicated, and gets no welcome sequence; a guest returning in two days is not duplicated (write-through to the read model) | ✅ |
| A transient Twenty outage retries with backoff and ends with exactly one of everything | ✅ |
| A response lost *after* Twenty applied the write creates no second guest and no second assignment (follow-on rows commit atomically with "job done") | ✅ |
| Honeypot and captcha token are validated then never stored; emails padded with spaces or left empty (mobile keyboards) are accepted | ✅ |
| Escalation sweep (remind at 36h, notify the lead at 72h) | ⏳ the rules are tested in `packages/core`; the sweep needs follow-up state mirrored from Twenty |

## 3. Twenty SDK and packaging (types and validators, no server)

| Item | Status | Evidence |
|---|---|---|
| The app's 69 entities (10 objects, 37 Person fields, 7+1 roles, 6 views, 7 nav items…) pass the SDK's own `define*` validators with no warnings | ✅ | `apps/fold-app/test/model.test.ts` runs the real validators from `twenty-sdk@2.43.0` |
| Types check against the shipped SDK declarations | ✅ | `tsc` on `apps/fold-app` |
| All identifiers unique and valid UUID v4 (the scaffold's `AGENTS.md` requires v4) | ✅ | `model.test.ts` |
| Relations are declared once and generated on both sides; each side points at the other | ✅ | `model.test.ts` |
| Object names do not collide with Twenty's standard objects | ✅ | `model.test.ts` checks against `STANDARD_OBJECT` |
| No free-text field can hold a confidence; the complete list of text fields is pinned | ✅ | `model.test.ts` (sensitive text policy) |
| Only admin/pastor/care team/service can read care requests; nobody can destroy records; no row-level permissions used | ✅ | `model.test.ts` (roles) — *as declared*; enforcement by a live Twenty is ❓ below |
| Docker image `twentycrm/twenty:v2.43.0` exists | ✅ | Docker Hub registry manifest lookup returned 200 for `v2.43.0` (and `latest`) on 2026-09-30 |
| `infra/docker-compose.yml` is valid and refuses to start without its secrets | ✅ | `docker compose config` (with and without secrets); the `Compose file is valid` job also passed on GitHub Actions (2026-09-30) |
| Every dependency has an acceptable license; CAL/SSPL/BUSL etc. are denied | ✅ | `pnpm check:licenses` + `scripts/test/licensePolicy.test.ts` (locally; the CI run of it is below) |
| Secret scan (gitleaks) finds nothing in the branch | ✅ | `Secret scan` job passed on GitHub Actions (2026-09-30) |
| Lint, typecheck and unit tests (Node 22 and 24) and the PostgreSQL 16 database tests are green **on GitHub Actions** | ✅ | Green on GitHub Actions for commit `3364a19` (run `36680060596`, 2026-09-30). The first two CI runs failed at setup, before any test ran: `pnpm/action-setup` refused because the pnpm version was declared in both `ci.yml` and `package.json`; removing it from `ci.yml` was the only change needed |
| The app **installs** with the pinned SDK on **Node 24** | ✅ | Installed on the VM with `twenty-sdk@2.43.0` on Node 24 (`npx twenty apply`, **not** `app:install`, which installs a published app); M0 `app-installed` then found all 10 objects and 37 Person fields (2026-10-01). Views, roles and the sidebar folder have **not** been looked at in the UI yet: the plan listed them as "will be created" |

## 4. Assumptions about a running Twenty (M0 must answer these)

Each row names the harness check and the **one place** in our code that changes if the answer is "no".

| Assumption | Status | Harness check | If wrong, change |
|---|---|---|---|
| `/healthz` answers, and a bearer API key authenticates against the REST API on a self-hosted `v2.43.0` | ✅ | `health`, `auth-and-rest` (2026-09-30, see the run log) | `TwentyClient` auth/headers |
| REST **list** response shape on Person: `{data, totalCount, pageInfo}` | ✅ | `auth-and-rest` observed `GET /rest/people` → keys `data, totalCount, pageInfo` | `unwrapRecords`, `nextCursorOf` in `twenty-client/src/client.ts` |
| REST create / list / read-back / delete for **our** objects (`/rest/<plural>`, `{data:{…}}`) | ✅ | `sourceref-idempotent`, `select-defaults`, `person-shapes`, `batch-limit-and-paging` all PASS (2026-10-01) on `followUps`, `households`, `attendances` and `people`. **Update** (PATCH) is not exercised by the harness | `unwrapRecords`, `nextCursorOf`, `listUpdatedSince` in `twenty-client/src/client.ts` |
| The CLI has `remote:add --url --api-key --as`, `plan` (preview) and `apply [--no-delete]`; `app:install` is described as "Install a **deployed** app" | ✅ | `twenty --help` and `remote:add --help` printed on the real VM (2026-09-30); matches `twenty-sdk@2.43.0` source | `infra/README.md` step 2 |
| `remote:add --as <existing name>` re-authenticates that remote with its **stored** URL and ignores `--url`; `local` always exists and points at `http://localhost:2020` | ✅ | Observed on the VM: `--as local --url http://localhost:3000` failed with `Cannot connect to Twenty server` while `curl localhost:3000/healthz` was 200 and `remote:list` showed `local  http://localhost:2020  [none]`; explained by the SDK source | use a new name such as `thefold` |
| `twenty plan` needs the app to be registered already: on a fresh server it fails with `No registration found for "<app id>"` | ✅ | Observed on the VM (2026-09-30) | `infra/README.md` step 2 |
| `twenty apply --force --no-delete` registers the app, uploads its files and reaches the server's metadata validation (`Syncing manifest…`) | ✅ | Observed on the VM (2026-09-30); `--force` skips the dry run that fails before registration | `infra/README.md` step 2 |
| The app builds and **typechecks** with the pinned SDK on **Node 24** | ✅ | Observed on the VM: `Building application files…` and `Running typecheck…` passed (2026-09-30) | none |
| Twenty **rejects reserved names** (`address`, `role`, `events`, `event`… 66 in all) on objects and fields; the SDK's own `define*` validators do **not** check this | ✅ | Observed on the VM: 5 of our names rejected. The list was read from `twenty-shared`'s `RESERVED_METADATA_NAME_KEYWORDS` embedded in `twenty-sdk@2.43.0`'s source map (not exported) | `TWENTY_RESERVED_NAMES` in `apps/fold-app/test/model.test.ts` — **refresh on every SDK bump** |
| A view must reference Person's own fields (`name`, `emails`…) by **Twenty's** ids, never ids derived from our registry | ✅ | Observed on the VM: `People by stage` → `Field metadata not found` for Person `name` | `viewFieldId` in `apps/fold-app/src/model/views.ts` |
| With the **service-account role**, REST can create and read what the services need: follow-ups (with the `sourceRef` lookup), people with composite emails/phones and relations, households, and batches of attendance | ✅ | Second and third M0 runs, 2026-10-01: `sourceref-idempotent`, `select-defaults`, `person-shapes`, `batch-limit-and-paging` PASS with a service-account key; the third run passes every automated check (`app-installed` read with the admin key). **Not exercised:** PATCH, the role's own soft-deletes (an admin key cleaned up), and care requests, touchpoints, group memberships, event registrations and events | `service` in `apps/fold-app/src/model/roles.ts` |
| The service-account role **cannot read workspace metadata** (`GET /rest/metadata/objects` → 403) | ✅ | Observed 2026-10-01. Expected least privilege: the services never read metadata; installing and verifying an app is an admin job (`FOLD_M0_ADMIN_API_KEY`) | none |
| The server **accepts our model** (after the two fixes above) | ✅ | The corrected model went through `twenty apply`; `app-installed` PASS: 10 objects and 37 Person fields present (2026-10-01). The 22 earlier errors were the two causes recorded above | `apps/fold-app/src/model`; the server names each entity it rejects |
| Filter syntax `sourceRef[eq]:"…"`, `updatedAt[gt]:"…"` and `starting_after` paging | ✅ | `sourceref-idempotent` (the filter is **not** ignored: an unknown ref finds nothing, distinct refs stay distinct) and `batch-limit-and-paging` (61 records walked exactly once, pages of 60 and 1) (2026-10-01). `order_by` is not asserted separately | REST adapter section of `client.ts` |
| A raw duplicate create with the same `sourceRef` is **rejected by the database** (`isUnique`) | ❓ | `sourceref-idempotent` only proves lookup-based idempotency (create once, find again). A check that POSTs the same ref twice is **not written yet**; it decides whether two racing workers could create duplicates | `scalarField` in `apps/fold-app/src/model/build.ts`; the single-writer lock |
| SELECT and BOOLEAN defaults written as `"'OPEN'"` and `false` apply as intended (not stored with quotes) | ✅ | `select-defaults` PASS, on our object and on Person (2026-10-01) | `scalarField` (SELECT case) |
| `defineField` can extend the standard Person object | ✅ | `app-installed`: all 37 extension fields present on Person (2026-10-01) | `personFieldConfigs` |
| Self-relations on Person work (`primaryShepherd`/`shepherdedPeople`, `guardian`/`dependents`) | ❓ | manual `self-relations` (the relations were created; the UI behaviour was not checked) | `RELATIONS` |
| Person accepts composite `emails`/`phones` payloads and relations set through `<field>Id` (`householdId`, `guardianId`) | ✅ | `person-shapes` PASS: they round-trip (2026-10-01) | `RestTwentyGateway` in `apps/community-api/src/twenty/gateway.ts` |
| Batch endpoint `/rest/batch/<plural>` works in 60-record chunks | ✅ | `batch-limit-and-paging` PASS (2026-10-01) | `MAX_BATCH` / `batchCreate` |
| The server enforces a 60-record batch limit | ✅ (it does **not**, on `v2.43.0`) | `batch-61` INFO: a batch of **61 was accepted in one request** (2026-10-01). Twenty documents 60, so the client keeps chunking at 60 | `MAX_BATCH` stays 60 on purpose |
| Cloud API limit ≈ 100 requests/minute; **self-host limit unknown** | ❓ | `rate-limit` (opt-in) | `DEFAULT_BUCKET` in `bucket.ts` |
| Webhook headers `X-Twenty-Webhook-Signature` / `-Timestamp`; HMAC-SHA256 over `"<timestamp>:<body>"`; timestamp unit | ❓ not seen in a delivery; the code now matches the build (it checked `"<timestamp>.<body>"` until the follow-up to the webhook run) | `webhook-signature` (opt-in). Read on 2026-10-02 from the `v2.43.0` build in the running `twenty-worker` (`call-webhook.job.js`, not an Enterprise file), because no delivery could be captured (run log): when the webhook has a secret, Twenty sends `X-Twenty-Webhook-Timestamp` (`Date.now()`, **milliseconds**), `X-Twenty-Webhook-Signature` (lowercase hex HMAC-SHA256 of **`"<timestamp>:<JSON body>"`, a colon, not a dot**) and a third header, `X-Twenty-Webhook-Nonce` (32 hex characters, not part of the signed string). The body is the same JSON that is signed. With no secret it sends none of the three | `defaultSignedPayload` in `webhook.ts`, now `:`; a test rejects a dot-signed delivery. Flip to ✅ when a real delivery gives `webhook.hint` |
| Invitation email reaches Mailpit once the **worker** has the `EMAIL_*` settings (it sends queued email; the server alone is not enough) | ✅ | invite a test member, look in http://localhost:8025 | `infra/docker-compose.yml` (worker environment). Observed 2026-10-01: with the settings on the server only, **no invitation reached Mailpit** (the email queue showed 5 completed jobs and the inbox was empty). After `39bcdd8` and the step-1 `up -d`, which recreated only `twenty-worker`, the resent invitations were logged by the worker as `[SmtpDriver] Email to '…' successfully sent` and 4 messages were in Mailpit. Invitations sent before the fix are not retried: resend them |
| Webhook payload shape and what a Person merge does to ids/events | ❓ | manual `person-merge`. The shape, read from the build and not yet seen in a delivery, is in the row below | webhook adapter; `person_alias` handling |
| Twenty's webhook body names the event as `eventName: "<object>.<action>"` with the record under `record` (the community API's receiver reads this, and tolerates `event`/`type`, `objectMetadata.nameSingular`, `data`) | ❓ not seen in a delivery | manual: `infra/README.md` 6.3; an `IGNORED` answer for a real delivery means the shape differs. Read from the `v2.43.0` build on 2026-10-02 (`transform-event-batch-to-webhook-events.js`): the body's keys are `targetUrl`, `eventName`, `objectMetadata: {id, nameSingular}`, `workspaceId`, `webhookId`, `eventDate`, `userId`, `workspaceMemberId`, `record`, and `updatedFields` on updates. That matches what the receiver reads, but the values of `eventName` for a delete and what `record` holds were not seen | `apps/community-api/src/http/webhookPayload.ts` |
| Twenty delivers a webhook to the community API inside the compose network | ✅ observed: it did **not**, as first configured; ❓ with the allow-list and the alias | 2026-10-02 (run log). Twenty's outbound HTTP client refuses every private address unless the host is listed in `OUTBOUND_HTTP_ALLOWED_INTERNAL_HOSTS` (default empty). The UI accepts and saves such a URL; the refusal happens at delivery, and **nothing is logged**: the worker prints `Outbound HTTP request: POST …` and `Job … CallWebhookJob processed`, and no request arrives. Its exact error, from Twenty's own agent run inside `twenty-worker`: `Request to internal IP address 172.18.0.8 is not allowed.` With `community-api` in the allow-list the same agent gets `200 {"ok":true}` from `http://community-api:4000/healthz`. Plain `http` is not the problem; the private address is | `infra/docker-compose.yml`, done after the run: `OUTBOUND_HTTP_ALLOWED_INTERNAL_HOSTS: community-api.thefold.internal` on `twenty-worker` (the worker sends webhooks), that name as a network alias of `community-api` (next row), and `infra/README.md` 6.3. Not `*`, and not the deprecated `OUTBOUND_HTTP_SAFE_MODE_ENABLED=false`: both open every private address to anything a workspace user can point Twenty at |
| Twenty's webhook form accepts the compose service name as the URL's host | ✅ (it does **not**, on `v2.43.0`) | Seen by the user in the UI on 2026-10-02: with `http://community-api:4000/v1/webhooks/twenty/grace` the form would not save; changing only the URL to the VM's IP address, it saved. No message was recorded. The likely rule is "a host name needs a dot (or is an IP or `localhost`)", which is not verified | `community-api.thefold.internal`, a network alias in `infra/docker-compose.yml`. ❓ that the form accepts it |
| `GET /rest/<plural>/<id>` returns the record (unwrapped like a list) and 404 once it is deleted | ✅ the shape, by hand; ✅ the hourly reconcile reads a changed person; ✅ observed: the reconcile's **changes listing does not see a delete**, so a deletes pass was added (❓ on a real Twenty); ❓ the worker's refetch from a webhook | by hand with the admin key on a throwaway household (2026-10-02): `200` `{data: {household: {…}}}`, keyed by the object's singular name, which `unwrapRecords` handles; after `DELETE` (a soft delete), and for an unknown id, `404` `NotFoundException: Record not found`. The fake server answers `{data: {record}}`. On the VM (2026-10-02, webhook run log): a person created and edited in Twenty was in `person_read` after the next hourly reconcile, but three people deleted in Twenty 37 minutes before that reconcile were **not** marked deleted, and nor was a fourth deleted after it. The reconcile lists `updatedAt[gt]:"…"`, and Twenty's list leaves soft-deleted records out (the same filter by hand returns only the live person; they appear with `filter=deletedAt[is]:NOT_NULL`). So without a working webhook a person deleted in Twenty stays live in the read model. Still to see: the refetch that a webhook hint sets off, for a change and for a delete | `TwentyClient.getRecord`; the deletes pass in `apps/community-api/src/sync/reconcile.ts` (`pass: 'deletes'`, its own cursor `<object>:deleted`) and `TwentyClient.listDeletedSincePage`, which lists `deletedAt[gt]:"…"` ordered by `deletedAt`. ❓ that Twenty returns soft-deleted records for `deletedAt[gt]` as it does for `deletedAt[is]:NOT_NULL` |
| The worker reaches Twenty at `http://twenty-server:3000` inside the compose network with the service-account key (no host-based workspace lookup) | ✅ | `infra/README.md` 6.2 on the VM (2026-10-02, run log): the card's people, household, attendance and follow-ups appeared in Twenty, created by `SERVICE_ACCOUNT_KEY` | `FOLD_TWENTY_BASE_URL` |
| The community service's own flow (setup → API → worker → Twenty) works against a real Twenty | ✅ for setup, the connection card and its writes; webhooks **do not arrive yet** (three causes, webhook run log); ❓ welcomer assignment, refetch | `infra/README.md` 6.1 and 6.2 on the VM (2026-10-02, run log): setup on the existing community database, a card → 2 people in 1 household, 1 attendance, 3 follow-ups, all 5 outbox jobs `DONE` at the first attempt; the same card again created nothing. Earlier, in the sandbox (2026-10-02) against the fake Twenty over HTTP: setup on a fresh database, a card → 2 people, 1 attendance, 3 follow-ups, all outbox jobs `DONE`; a signed webhook queued, a forged one 401; SIGTERM stops both cleanly | `apps/community-api` |
| Member sign-in on the live stack: the worker's SMTP mail reaches Mailpit, the emailed link signs a fake adult in from a browser at `FOLD_PUBLIC_URL`, the browser's `Origin` matches the `Host` the API sees, and the session cookie works over plain http on the VM (ADR 0007) | ❓ | `infra/README.md` 6.4 | `apps/community-api/src/http/portal.ts`, `src/portal/signIn.ts`, `src/mail/` |
| `churchGroup` reaches `group_read` by webhook and by the hourly reconcile (including deletes) | ❓ | `infra/README.md` 6.5 step 1 | `SYNCED_OBJECTS.churchGroup`, `groupReadFromTwenty` |
| The REST filter `and(groupId[eq]:"…",personId[eq]:"…")` finds a person's membership of a group, and the service role may create and PATCH `groupMemberships` | ❓ | `infra/README.md` 6.5 steps 2–3 (the outbox job is `DONE`, one membership in Twenty) | `TwentyClient.findOneByIds`, `RestTwentyGateway.upsertMembership` |
| `grant-role` runs inside the community-api container, and a welcome lead confirms a shared-address sign-in from the browser | ❓ | `infra/README.md` 6.5, "Confirming a shared family address" | `src/cli.ts`, `src/portal/confirm.ts`, `src/http/staffRoutes.ts` |
| Workspace creation and app install can be scripted | ❓ | manual `multi-workspace` | provisioner (ADR 0002) |
| `IS_MULTIWORKSPACE_ENABLED` is licensed/allowed for self-hosters | ❓ | manual `multi-workspace` | ADR 0002 (cells vs shared workspaces) |
| Everything works with **no** enterprise key | ❓ | manual `no-enterprise-key` | `docs/enterprise-avoid.md` |
| The app works with logic functions and the code interpreter disabled (their production default) | ❓ | manual `logic-functions-off` | none expected: The Fold uses none |
| A user can sign in with email and password through `getLoginTokenFromCredentials` then `getAuthTokensFromLoginToken` (both on `POST /metadata`) and use the access token as a Bearer token on `/rest` and `/graphql` | ✅ | `care-permissions-api` signed in as both test users (fourth and fifth runs, 2026-10-01), and so did `infra/README.md` 5.2 by hand with `curl` | `login.ts`; the shapes from the v2.43.0 generated schema (`twenty-client-sdk`) were right as written |
| A user without the care role cannot see a `careRequest` over **REST** (list, by id, person with relations, create), **GraphQL**, **global search** or the **timeline** | ✅ | automated `care-permissions-api` **PASS** (fifth run, 2026-10-01, and again on the sixth, 2026-10-02, under the stricter rule that a 400 counts as a refusal only when it says so), as a Church staff user with a Care team user as the positive control. The fourth run was INFO: three request shapes were wrong for this server, so those surfaces were checked by hand first (run log), with no leak, and the harness was then fixed | roles in `model/roles.ts`; if any surface leaks, **do not host a real congregation**. Church staff is refused with HTTP 400 `PERMISSION_DENIED` on REST (list, by id, create) and `FORBIDDEN` on GraphQL. The three rows below are the shapes this needed |
| `GET /rest/people/<id>` expands relations at `depth=1`; anything deeper is rejected | ✅ | by hand, 2026-10-01: `depth=2` → 400 `'depth=2' parameter invalid. Allowed values are 0, 1`. At `depth=1` the Care team user gets `careRequests` on the person; the Church staff user gets the person with no `careRequests` or `careRequestsOwned` field at all | `RELATION_DEPTH` in `twenty-client/src/m0/careChecks.ts` |
| GraphQL `search` (on `/graphql`, not `/metadata`) only tells the roles apart when it names its objects (`includedObjectNameSingulars`) | ✅ over the API; ❓ what the browser's search box does | by hand, 2026-10-01: with **no** object list it is `FORBIDDEN` for the Church staff **and** the Care team user (an admin key gets results). Scoped to `careRequest`: Care team finds the record, Church staff `FORBIDDEN`. Scoped to `person`: both get the person only | `SEARCH_SCOPES` in `careChecks.ts`. If the search box (Ctrl/Cmd+K) does not work for these roles in the browser, that is a usability finding for manual `care-permissions`, not a leak |
| A "record created" timeline entry points at its record through `target<Object>Id` (`targetCareRequestId`); `linkedRecordId` is null, and the entry is not attached to the person | ✅ | by hand, 2026-10-01: the admin key and the Care team user get the entry with `filter=targetCareRequestId[eq]:"<id>"`; the Church staff user gets `200` with no entry, sees only the person's own "created" entry on the person's timeline, and no care-request entry in an unfiltered listing | `timelineOfCareRequest` in `careChecks.ts` |
| Same, in the **browser**: sidebar, direct URL `/objects/careRequests`, the search box, the person page's timeline tab, People CSV export | ❓ | manual `care-permissions` (UI only). Also check that the search box **works at all** as each role (see the `search` row above) | roles in `model/roles.ts` |
| A Church staff or Care team user cannot create, edit, activate or run a workflow, so cannot build one that reads care requests | ✅ over the API; ❓ in the browser | manual `workflow-bypass`, done over the API on 2026-10-01 (run log): every workflow operation tried is refused for the Church staff user, including running Twenty's existing active manual workflow; the Care team user was refused on the ones tried as that user (read, add a step, activate, run). The browser was not used, and the Pastor, Welcome team lead, Read only and Twenty's built-in roles were not tested | roles in `model/roles.ts`: no role grants the workflow objects, and only "Church admin" has settings |
| A workflow acts with the rights of the user who set it off, not with more | ❓ | **not answered** by the 2026-10-01 attempt: adding a step and running a workflow are refused for the admin **API key** too (`Forbidden resource`), so no "Search records on care requests" workflow could be built to observe, and Twenty's active sample workflow did not fire for a staff-created person. Needs an admin signed in to the browser: build a manual workflow with "Search records" on care requests, run it, then check from the staff side whether its output is reachable | restrict workflow editing to admins (ADR 0004), which is what the roles do today |

## 5. Not built yet

| Item | Status |
|---|---|
| Community API and worker | ✅ built (2026-10-02, ADR 0006): connection-card intake, Twenty webhook receiver, outbox/refetch/reconcile/housekeeping worker, setup and provisioning, Docker image and compose services. Member sign-in by emailed link with staff confirmation of shared addresses (ADR 0007) and groups (find, ask to join, leaders answer; ADR 0008) built, all ❓ on the live stack. Not built: the group feed, portal read APIs beyond groups, escalation sweeps for overdue follow-ups, metrics. Against a real Twenty: the card flow ✅; webhooks did not arrive and the reconcile missed deletes (section 4, webhook run log); all three causes and the reconcile gap are fixed in the code, ❓ until the next VM run |
| Member portal UI | ⏳ (`apps/portal-web` is not started) |
| Email delivery, unsubscribe/bounce handling, DSAR export/erase | ⏳ |
| Provisioner (workspace/cell creation) | ⏳ (blocked on the M0 answers above). Must also deactivate Twenty's two sample workflows, which every new workspace ships active (see the `workflow-bypass` entry); until then it is a manual step in `infra/README.md` step 1 |
| CLA enforcement in CI | ⏳ (`CLA.md` is a draft awaiting counsel) |
| Weekly canary against the next Twenty tag | ⏳ (needs M0 to be scriptable first) |
| Legal review: AGPL obligations for hosting, GDPR Art. 9 / COPPA / FCRA, DPA | ⏳ needs counsel |

## 6. M0 run log

Paste each `pnpm m0` table here (newest first) with the date and the Twenty version, and update the ❓ rows above.

### Webhook test — 2026-10-02 — Twenty v2.43.0 — at `0da7e10` — **no delivery reached the community API**

`infra/README.md` 6.3 on the VM, with fake data only. The webhook was registered by hand in Twenty's UI; nothing was created or changed in Twenty's
webhook settings by this run, and no product code was changed.

| Step | Observed |
|---|---|
| `FOLD_TWENTY_WEBHOOK_SECRET` set (48 characters), `FOLD_LOG_LEVEL=debug`, `up -d --build` | `community-setup`: `setup.migrated` (none applied, 4 already applied), `setup.tenant_ready` with `apiKeyVersion: 1`, `webhookSecretVersion: 1`. `readyz` 200. Only the three community containers were recreated |
| The webhook as Twenty holds it (`/metadata` GraphQL, `webhooks { id targetUrl operations description secret }`, read-only, admin key) | one webhook: `targetUrl` **`http://192.168.51.10:4000/v1/webhooks/twenty/grace`** (the VM's LAN address, not `http://community-api:4000/…`), `operations` `["*.*"]`, empty description, and a secret equal to the one in `infra/.env` (compared, not printed) |
| The test people | Sam Smoke, Kit Smoke and "Staff" were already soft-deleted in Twenty (`deletedAt` 18:40:10 and 18:40:20 UTC, by a signed-in user, eleven minutes before this run began). They were left deleted. A throwaway person "Webhook Throwaway" was used instead |
| Create the throwaway person (`POST /rest/people`), then `PATCH` its `jobTitle`, then later `DELETE` it, all with the admin key | each succeeded (the `PATCH` and `DELETE` answered 200). For each, `twenty-worker` logged `Processing job … CallWebhookJobsJob`, `[SecureHttpClientService] Outbound HTTP request: POST http://192.168.51.10:4000/v1/webhooks/twenty/grace [workspace=…, source=webhook]`, and `Job … CallWebhookJob processed on queue webhook-queue` within 5 to 65 ms. No error or warning line. The same lines are there for the 18:40 deletions |
| `community-api` log at debug, `webhook_inbox`, `webhook_delivery` | **nothing**: no `webhook.hint`, `webhook.rejected` or `webhook.ignored`; both tables empty. No request arrived |
| Why: Twenty's own outbound agent (`create-ssrf-safe-agent.util.js` from the build), run with `node` inside `twenty-worker` against `GET /healthz` | allow-list empty (the default): `http://community-api:4000` → `Request to internal IP address 172.18.0.8 is not allowed.`; `http://192.168.51.10:4000` → `Request to internal IP address 192.168.51.10 is not allowed.` Allow-list `["community-api"]`: `http://community-api:4000` → `200 {"ok":true}`. Allow-list `["192.168.51.10"]`: that address **times out** from the container (plain `wget` from `twenty-worker` times out too; from the host it answers 200), so the LAN address would not work even when allowed |
| Hourly reconcile at 19:17:37 UTC | `worker.tick … reconciledPeople: 1, errors: 0`; the throwaway person is in `person_read` (`twenty_updated_at` 18:55:40.91, the time of the edit). Sam, Kit and Staff, deleted in Twenty at 18:40, still have `deleted_at` null |
| After deleting the throwaway person at 19:18 | again an `Outbound HTTP request` and nothing received. Its `person_read` row is not marked deleted, and by the row in section 4 a later reconcile will not mark it either |
| `FOLD_LOG_LEVEL=info`, `up -d` | the community containers recreated; `readyz` 200 |

Three separate things stand between Twenty and a `webhook.hint`, in the order a delivery meets them:

1. **Twenty refuses the address.** `twenty-worker` needs `OUTBOUND_HTTP_ALLOWED_INTERNAL_HOSTS: community-api` (section 4). Twenty's UI saved the
   URL without complaint and the refusal is silent in the logs: the job code records it only in Twenty's event log, as
   `Webhook URL resolves to a private/internal IP address`.
2. **The registered URL is the LAN address.** It has to be `http://community-api:4000/v1/webhooks/twenty/grace`; the LAN address is unreachable
   from the containers on this VM.
3. **The signed string.** Read from the build, not seen: Twenty signs `"<timestamp>:<body>"`, the receiver checks `"<timestamp>.<body>"`, so
   deliveries would be `401 BAD_SIGNATURE` once they arrive. The timestamp is in milliseconds, which the receiver already accepts.

Not seen, so still ❓: a real delivery's headers and body, the receiver's answer to one, the refetch a hint sets off, and a delete arriving by
webhook.

**After this run (same day, in the code, not yet run on the VM):** the URL in point 2 cannot be entered either, because Twenty's form refuses a
host without a dot (seen by the user). The compose file now gives `community-api` the alias `community-api.thefold.internal` and lists that
name, and only that name, in `OUTBOUND_HTTP_ALLOWED_INTERNAL_HOSTS` on `twenty-worker`; the webhook's URL becomes
`http://community-api.thefold.internal:4000/v1/webhooks/twenty/grace` (`infra/README.md` 6.3). The receiver now checks `"<timestamp>:<body>"`.
The reconcile has a second pass that lists records deleted in Twenty and marks them deleted, so the people above are marked at its first run. Left behind as fake test data: the four `person_read` rows above, all of whose people are now soft-deleted in Twenty, and the household,
attendance and three follow-ups of the Smoke household, which are still live in Twenty.

### Community service first start and M0 run — 2026-10-02 (eighth) — Twenty v2.43.0 — at `8918939` — **8 PASS · 0 FAIL · 1 INFO · 2 SKIP · 8 MANUAL**

`8918939` added the community service to the compose file. `infra/README.md` 6.1 and 6.2 were followed on the VM, then the harness was run again.

| Step | Observed |
|---|---|
| `up -d --build` with the three new secrets, `FOLD_TENANT_SLUG=grace` and the service-account key in `infra/.env` | the image built; `community-setup` exited 0; `community-api` healthy, `community-worker` up. The six existing containers were **not** recreated |
| `community-setup` log | `setup.bootstrapped`, `setup.migrated` (4 migrations applied, 0 already applied), `setup.tenant_ready` (`apiKeyVersion` 1, no webhook secret) |
| `GET localhost:4000/readyz` and `/healthz` | `200 {"ok":true}` |
| First worker tick | `reconciledPeople: 1`, `errors: 0`: the worker read Twenty at `http://twenty-server:3000` with the service-account key |
| `POST /v1/connection-card` (6.2: the fake "Sam Smoke" with a child "Kit") | `202 {"received":true}`; API log `card.received … QUEUED, NEW`; four seconds later `worker.tick … outboxDone: 5`; the outbox holds 5 jobs, all `DONE` after 1 attempt |
| In Twenty (read with the admin key) | Sam: email set, `consentEmail` true, household primary contact. Kit: `isMinor` and `doNotContact` true, no email, `guardianId` = Sam. Both `NEW_GUEST` in one "Smoke household". One `SERVICE` attendance for 2026-10-02. Three open follow-ups (`WELCOME` due in 2 days, `GROUP_INTRO` in 7, `FOLLOW_UP` in 21) with `ownerId` null, as expected with no welcomer |
| Read model | `person_read` has the same 3 people as Twenty (the two above and one that was already there) |
| The same card again, the email typed with capitals and spaces | `202 {"received":true}`; `card.received … DUPLICATE, EXISTING`; no new outbox job; Twenty still has 3 people, 1 household, 1 attendance, 3 follow-ups |
| `pnpm m0` afterwards | every row as in the seventh run; no `cleanup` row; the worker logged no error while the harness created and deleted its records |

The README says the card answers `{"received":true}`; the status with it is `202`.

Not exercised: webhooks (6.3: no secret is set and none is registered in Twenty), welcomer assignment against a real person, the worker's refetch and
the hourly reconcile of a changed or deleted person, key rotation, and stopping the containers. Sam and Kit Smoke, their household, attendance and
follow-ups were left in the workspace as fake test data.

### M0 run — 2026-10-02 (seventh) — Twenty v2.43.0 — service account, with the two test users — **8 PASS · 0 FAIL · 1 INFO · 2 SKIP · 8 MANUAL**

A routine re-run at `c0734b6` with no code change since the sixth: the stack had been up for 37 hours (all six services up, `twenty-server` healthy)
and the same keys and test users still worked. Nothing differs from the sixth run, and there is no `cleanup` row. Just before it, the harness was
run once without the two test users' passwords: the same seven PASS and one INFO, with `care-permissions-api` at SKIP (7 PASS · 0 FAIL · 1 INFO ·
3 SKIP · 8 MANUAL), which is what the harness is meant to report when those variables are not set.

| Status | Check | Observed |
|---|---|---|
| PASS | `health`, `auth-and-rest`, `app-installed`, `sourceref-idempotent`, `select-defaults`, `person-shapes`, `batch-limit-and-paging` | as in the sixth run |
| **PASS** | `care-permissions-api` | as in the sixth run, word for word: REST list, by id and create denied (HTTP 400, permission refusal); REST person with relations: nothing returned; GraphQL `careRequests`: denied (GraphQL error); global search: care requests only denied, people only nothing returned, every object denied; timeline of the care request and of the person: nothing returned. The Care team user could read it (control) |
| INFO | `batch-61` | accepted 61 records in one request |
| SKIP | `rate-limit`, `webhook-signature` | opt-in checks not enabled |
| MANUAL | 8 checks | not done in this run |

No ❓ row changes: this run observed nothing new. Still open before a real congregation goes on this instance: the browser half of
`care-permissions`, and whether a workflow acts with more rights than the user who set it off.

### M0 run — 2026-10-02 (sixth) — Twenty v2.43.0 — service account, with the two test users — **8 PASS · 0 FAIL · 1 INFO · 2 SKIP · 8 MANUAL**

The first run after `980b4f1`, which counts a 400 or a GraphQL error as a refusal only when its text says `PERMISSION_DENIED` or `FORBIDDEN`. Against
the live server the stricter rule changes nothing but the wording: the three REST denials now read "permission refusal". Same keys and test users as
the fifth run; no `cleanup` row. The two sample workflows were already deactivated when this ran.

| Status | Check | Observed |
|---|---|---|
| PASS | `health`, `auth-and-rest`, `app-installed`, `sourceref-idempotent`, `select-defaults`, `person-shapes`, `batch-limit-and-paging` | as in the fifth run |
| **PASS** | `care-permissions-api` | as the Church staff user every surface denied or hid the care request: REST list, by id and create denied (HTTP 400, permission refusal); REST person with relations: nothing returned; GraphQL `careRequests`: denied (GraphQL error); global search: care requests only denied, people only nothing returned, every object denied; timeline of the care request and of the person: nothing returned. The Care team user could read it (control) |
| INFO | `batch-61` | accepted 61 records in one request |
| SKIP | `rate-limit`, `webhook-signature` | opt-in checks not enabled |
| MANUAL | 8 checks | `workflow-bypass` was done by hand over the API (entry below); the rest not done |

Still open before a real congregation goes on this instance: the browser half of `care-permissions`, and whether a workflow acts with more rights than
the user who set it off (the unanswered half of `workflow-bypass`).

### `workflow-bypass` by hand — 2026-10-01 — Twenty v2.43.0 — over the API, as the two test users — **passes as written; the elevated-rights question is open**

The check asks a Church staff user to build a workflow with "Search records" on care requests and run it: "it must fail or return nothing". It failed
at every step for the Church staff user (signed in as in `infra/README.md` 5.2). The Care team user was tried on reading workflows, adding a step,
activating and running, and was refused each time. A fake person and care request existed throughout and were deleted afterwards, with the person
the staff user created; no company, workflow or run was left behind.

| Attempt as Church staff | Answer |
|---|---|
| Read `workflows`, `workflowVersions`, `workflowRuns` over REST; versions and runs over GraphQL too | `PERMISSION_DENIED` / `FORBIDDEN` |
| Create a workflow: REST `POST /rest/workflows`, GraphQL `createWorkflow`, `createCoreWorkflow` | `PERMISSION_DENIED` / `FORBIDDEN` |
| Add a "Search records" step: `createWorkflowVersionStep` | `FORBIDDEN` |
| `activateWorkflowVersion` | `FORBIDDEN` |
| `runWorkflowVersion`, with an impossible id and with the id of Twenty's active manual sample workflow ("Quick Lead") | `FORBIDDEN` |
| Create a version or a run as a plain record: `createWorkflowVersion`, `createWorkflowRun` | `Method not allowed` |
| Read `workflowAutomatedTriggers` | **`200`**: the trigger settings of the sample workflow are readable by staff. No care data in them |

What this does **not** show:

- **Whether a workflow acts with more rights than the user who set it off.** `createWorkflowVersionStep`, `runWorkflowVersion` and `coreWorkflows` answer
  `Forbidden resource` for the admin **API key** as well, so a workflow could not be built or run without an admin signed in to the browser. As a
  substitute, the staff user (who is refused on `companies`) created a person with an email, to see whether Twenty's active sample workflow "Create
  company when adding a new person" (trigger `person.upserted`) would create a company on their behalf. No run started within 40 seconds, the
  workspace has 0 workflow runs in total, and the worker logged nothing about it, so this proved nothing either way.
- **The browser.** Every answer above is the server's reply to the operation by name on `/graphql` or `/rest`; that these are exactly the calls the
  web app sends was not confirmed.
- **Other roles.** Pastor, Welcome team lead, Read only and Twenty's built-in roles were not tested.

Also seen: Twenty's two sample workflows, "Quick Lead" (manual) and "Create company when adding a new person" (database event), were **ACTIVE** in
this workspace.

**Deactivated the same day (2026-10-01), on the owner's decision.** `deactivateWorkflowVersion` with the admin API key answered `true` for both;
each workflow and its one version now read `DEACTIVATED`, and the `person.upserted` automated trigger is gone (the workspace has none). This is
workspace state, not code: nothing in this repository does it, so a newly created workspace ships with both workflows active again. Turning
them off is a job for the provisioner (section 5), which is not built yet.

### M0 run — 2026-10-01 (fifth) — Twenty v2.43.0 — service account, with the two test users — **8 PASS · 0 FAIL · 1 INFO · 2 SKIP · 8 MANUAL**

The first run with `care-permissions-api` at PASS, after the three request shapes below were fixed. Same keys as the third run; the test users are
`staff@fold-test.example` (Church staff) and `care@fold-test.example` (Care team), both fake. No `cleanup` row, so nothing was left behind.

| Status | Check | Observed |
|---|---|---|
| PASS | `health`, `auth-and-rest`, `app-installed`, `sourceref-idempotent`, `select-defaults`, `person-shapes`, `batch-limit-and-paging` | as in the third run |
| **PASS** | `care-permissions-api` | as the Church staff user every surface denied or hid the care request: REST list, by id and create denied (HTTP 400); REST person with relations: nothing returned; GraphQL `careRequests`: denied (GraphQL error); global search: care requests only denied, people only nothing returned, every object denied; timeline of the care request and of the person: nothing returned. The Care team user could read it (control) |
| INFO | `batch-61` | accepted 61 records in one request |
| SKIP | `rate-limit`, `webhook-signature` | opt-in checks not enabled |
| MANUAL | 8 checks | not done |

This covers the **API** half of care permissions only. The browser half (`care-permissions`) and `workflow-bypass` are still not done, so the rule stands:
do not put a real congregation on this instance until both pass.

### Care permissions by hand — 2026-10-01 — `infra/README.md` section 5, for the three surfaces the fourth run could not test

A fake person and care request were seeded with the service-account key and deleted afterwards with the admin key (both `HTTP 200`; nothing left behind).
Controls: the Care team user read the care request by id (`200`), and the Church staff user could list people (`200`).

| Surface | Care team (control) | Church staff | Result |
|---|---|---|---|
| Person with relations, `depth=1` | care request listed on the person | person returned with no `careRequests` or `careRequestsOwned` field | no leak |
| Global search scoped to `careRequest` | finds it | `FORBIDDEN` | no leak |
| Global search scoped to `person` | the person only | the person only | no leak |
| Global search, no object list | `FORBIDDEN` | `FORBIDDEN` | no leak (and no use as a control) |
| Timeline, `targetCareRequestId[eq]` | 1 entry (`recordCreated`) | `200`, 0 entries | no leak |
| Timeline of the person, `targetPersonId[eq]` | not run | only the person's own "created" entry | no leak |
| Timeline, newest 60, no filter | not run | 8 entries, none with a care-request target | no leak |

What the fourth run got wrong, each fixed in `careChecks.ts`, the fake server and README section 5: `depth=2` is rejected by this server (`Allowed values
are 0, 1`); `search` with no object list is refused for both roles; and the timeline entry carries the record in `targetCareRequestId`, with
`linkedRecordId` null. The REST refusals the fourth run reported as "denied (HTTP 400)" were read here too: all three say `PERMISSION_DENIED`, and
GraphQL `careRequests` says `FORBIDDEN`, so they are permission refusals and not rejected payloads.

### M0 run — 2026-10-01 (fourth) — Twenty v2.43.0 — service account, with the two test users — **7 PASS · 0 FAIL · 2 INFO · 2 SKIP · 8 MANUAL**

The first run of `care-permissions-api` against a real server. Sign-in worked for both users. No leak was found, but three surfaces were not tested, so the
row was INFO and not a PASS.

| Status | Check | Observed |
|---|---|---|
| PASS | the same seven checks as the third run | unchanged |
| INFO | `batch-61` | accepted 61 records in one request |
| **INFO** | `care-permissions-api` | no leak found on 4 surfaces: REST list, by id and create denied (HTTP 400); GraphQL `careRequests` denied (GraphQL error). **NOT tested:** REST person with relations (the care request did not appear on the person even for the Care team); global search (the Care team could not find it either); timeline (no entry found within the wait). The Care team user could read the record (control) |
| SKIP | `rate-limit`, `webhook-signature` | opt-in checks not enabled |
| MANUAL | 8 checks | not done |

### M0 run — 2026-10-01 (third) — Twenty v2.43.0 — as the **service account**; admin key only for the metadata read and cleanup — **7 PASS · 0 FAIL · 1 INFO · 2 SKIP · 8 MANUAL**

The two keys were created in Twenty as `SERVICE_ACCOUNT_KEY` (role "The Fold service account") and `ADMIN_KEY` (an admin role). The checks ran as the
first; the second did only the `/rest/metadata/objects` read and the cleanup. The report header now says `Twenty v2.43.0` and there is **no `cleanup`
row**, so nothing was left behind.

| Status | Check | Observed |
|---|---|---|
| PASS | `health`, `auth-and-rest` | HTTP 200; `GET /rest/people` → keys `data, totalCount, pageInfo` |
| PASS | `app-installed` | 10 objects and 37 Person fields present (read with the admin key) |
| PASS | `sourceref-idempotent`, `select-defaults`, `person-shapes`, `batch-limit-and-paging` | as in the earlier runs, now as the service account: 61 attendances in 2 batches, defaults applied, composite emails/phones and relations round-trip |
| INFO | `batch-61` | accepted 61 records in one request |
| SKIP | `rate-limit`, `webhook-signature` | opt-in checks not enabled |
| MANUAL | 8 checks | not done |

This is the first run in which every automated check passes **with the least-privilege role the real services will use**. Still not exercised: PATCH, the
role's own soft-deletes (the admin key cleaned up), the objects the harness never touches (care requests, touchpoints, group memberships, event
registrations, events), the raw-duplicate `sourceRef` rejection, the rate limit, the webhook signature, and every manual check. Do not put a real congregation
on this instance until `care-permissions` and `workflow-bypass` pass.

Added after this run: the automated `care-permissions-api` check (and `infra/README.md` section 5, the same checks by hand with `curl`). It has not run
against a real server yet, so it is not in any table above; without the four `FOLD_M0_STAFF_*` / `FOLD_M0_CARE_*` variables it reports `SKIP`.

### M0 run — 2026-10-01 (second) — Twenty v2.43.0 — as the **service account**, admin key for cleanup — **6 PASS · 1 FAIL · 1 INFO · 2 SKIP · 8 MANUAL**

The checks ran as a key with the "The Fold service account" role; `FOLD_M0_ADMIN_API_KEY` (an admin key) did the cleanup, and no `cleanup` row appeared, so nothing was left behind.

| Status | Check | Observed |
|---|---|---|
| PASS | `health`, `auth-and-rest` | HTTP 200; `GET /rest/people` → keys `data, totalCount, pageInfo` |
| **FAIL** | `app-installed` | `GET /rest/metadata/objects` → **403 "authentication failed"** |
| PASS | `sourceref-idempotent`, `select-defaults`, `person-shapes`, `batch-limit-and-paging` | same observations as the admin run: 61 attendances created in 2 batches, defaults applied, composite emails/phones and relations round-trip |
| INFO | `batch-61` | accepted 61 records in one request |
| SKIP / MANUAL | as before | opt-in checks not enabled; 8 manual checks not done |

The FAIL is **a limit of the key, not of the install**: the service-account role may not read workspace metadata, which is correct least privilege (the real services never need it). The harness used that key for the metadata read; fixed in `0cfd515` by running that one read, and the cleanup, with the admin client (`adminClient`, `FOLD_M0_ADMIN_API_KEY`). The third run above passes. Not exercised by this run: PATCH, the role's own soft-deletes (the admin key did the cleanup), and the objects the harness does not touch (care requests, touchpoints, group memberships, event registrations, events).

### M0 run — 2026-10-01 — Twenty v2.43.0 — `http://localhost:3000` (self-hosted, TrueNAS VM, Node 24) — **admin key; app installed; 7 PASS · 0 FAIL · 1 INFO · 2 SKIP · 8 MANUAL**

The report header said `Twenty unknown` because neither `FOLD_M0_TWENTY_VERSION` nor `TWENTY_TAG` was exported; the version is the pinned image tag. The
API key used was an **admin** key (`build1`, confirmed by the user afterwards), so this run did not test least privilege; the next entry does. The harness deletes the records it creates.

| Status | Check | Observed |
|---|---|---|
| PASS | `health` | HTTP 200 |
| PASS | `auth-and-rest` | `GET /rest/people` → keys `data, totalCount, pageInfo` |
| PASS | `app-installed` | 10 objects and 37 Person fields present |
| PASS | `sourceref-idempotent` | created once, found again, distinct refs stayed distinct, an unknown ref found nothing |
| PASS | `select-defaults` | defaults applied |
| PASS | `person-shapes` | composite emails/phones and household/guardian relations round-trip |
| PASS | `batch-limit-and-paging` | created 61 in 2 batches; listing returned pages of 60, 1 and saw each record exactly once |
| INFO | `batch-61` | accepted 61 records in one request; the client still chunks at 60 to be safe |
| SKIP | `rate-limit`, `webhook-signature` | opt-in checks not enabled |
| MANUAL | 8 checks | not done: `no-enterprise-key`, `care-permissions`, `workflow-bypass`, `multi-workspace`, `logic-functions-off`, `app-install` (visual), `self-relations`, `person-merge` |

What this does **not** prove: that the database rejects a raw duplicate `sourceRef` (the check exercises lookup-based idempotency only); the rate limit; the
webhook signature; or any of the privacy checks. Do not put a real congregation on this instance until `care-permissions` and `workflow-bypass` pass.

### Install attempt — 2026-09-30 — Twenty v2.43.0, `twenty-sdk` 2.43.0, Node 24 — **rejected by the server**

`npx twenty plan` → `No registration found for "e9d9ab0a-…"` (the dry run precedes registration). `npx twenty apply --force --no-delete` → registered the
app, uploaded 1 file, `Syncing manifest…`, then **22 errors, nothing applied**:

| Entity | Errors | Cause | Fix |
|---|---|---|---|
| `fieldMetadata` | 5 × `INVALID_FIELD_INPUT: This name is reserved` (`address`, `role`, `events` twice, `event`) | Twenty reserves these names | renamed to `homeAddress`, `groupRole`, `churchEvents` (both), `churchEvent` |
| `fieldMetadata` | 2 × `FIELD_METADATA_NOT_FOUND: Relation field target metadata not found` | the other side of those relations was rejected | expected to disappear with the renames |
| `viewField` | 15 × `INVALID_VIEW_DATA: Field metadata not found` | one is our `People by stage` column for Person `name` (an id from our registry instead of Twenty's standard id); the other 14 belong to the default views of objects whose fields failed | `viewFieldId`; the rest expected to disappear |

Not yet known: whether the server accepts the corrected model. The next `apply` will say.

### M0 run — 2026-09-30 — Twenty v2.43.0 — `http://localhost:3000` (self-hosted, TrueNAS VM, Node 24) — **before the app was installed**

The app was not installed when this ran, so every check that touches a custom object failed for that one reason. Those failures say
nothing yet about our filter, default-value, person-shape or batch assumptions; they stay ❓ until the next run. Long lists are abbreviated.

| Status | Check | Observed |
|---|---|---|
| PASS | `health` | HTTP 200 |
| PASS | `auth-and-rest` | `GET /rest/people` → keys `data, totalCount, pageInfo` |
| FAIL | `app-installed` | expected: all 10 custom objects and all 37 Person extension fields missing |
| FAIL | `sourceref-idempotent` | `GET /rest/followUps` → 400 `object 'followUps' not found` |
| FAIL | `select-defaults` | `POST /rest/followUps` → 400 `object 'followUps' not found` |
| FAIL | `person-shapes` | `POST /rest/households` → 400 `object 'households' not found` |
| FAIL | `batch-limit-and-paging` | `POST /rest/batch/attendances` → 400 `object 'attendances' not found` |
| INFO | `batch-61` | rejected with the same 400 (no information about the batch limit) |
| SKIP | `rate-limit`, `webhook-signature` | opt-in checks not enabled |
| MANUAL | 10 checks | not done yet; rows above unchanged |

What the 400s do show: REST object paths are the plural of the object's API name (`followUps`, `households`, `attendances`), which is what the client
already assumes. The install command in `infra/README.md` was wrong at the time (`app:install` installs a *published* app); it now says
`plan` then `apply`.
