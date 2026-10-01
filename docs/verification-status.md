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
| Webhook headers `X-Twenty-Webhook-Signature` / `-Timestamp`; HMAC-SHA256 over `"<timestamp>.<body>"`; timestamp unit | ❓ | `webhook-signature` (opt-in) | `defaultSignedPayload` in `webhook.ts` — nothing else |
| Webhook payload shape and what a Person merge does to ids/events | ❓ | manual `person-merge` | webhook adapter; `person_alias` handling |
| Workspace creation and app install can be scripted | ❓ | manual `multi-workspace` | provisioner (ADR 0002) |
| `IS_MULTIWORKSPACE_ENABLED` is licensed/allowed for self-hosters | ❓ | manual `multi-workspace` | ADR 0002 (cells vs shared workspaces) |
| Everything works with **no** enterprise key | ❓ | manual `no-enterprise-key` | `docs/enterprise-avoid.md` |
| The app works with logic functions and the code interpreter disabled (their production default) | ❓ | manual `logic-functions-off` | none expected: The Fold uses none |
| Object/field-level roles hide `careRequest` on REST, GraphQL, search, timeline and export | ❓ | manual `care-permissions` | roles in `model/roles.ts`; if any surface leaks, **do not host a real congregation** |
| Workflows cannot be used to read objects a role cannot read | ❓ | manual `workflow-bypass` | restrict workflow editing to admins (ADR 0004) |

## 5. Not built yet

| Item | Status |
|---|---|
| HTTP API, worker processes, member portal UI | ⏳ (`apps/portal-web` and the API/worker entrypoints are not started) |
| Email delivery, unsubscribe/bounce handling, DSAR export/erase | ⏳ |
| Provisioner (workspace/cell creation) | ⏳ (blocked on the M0 answers above) |
| CLA enforcement in CI | ⏳ (`CLA.md` is a draft awaiting counsel) |
| Weekly canary against the next Twenty tag | ⏳ (needs M0 to be scriptable first) |
| Legal review: AGPL obligations for hosting, GDPR Art. 9 / COPPA / FCRA, DPA | ⏳ needs counsel |

## 6. M0 run log

Paste each `pnpm m0` table here (newest first) with the date and the Twenty version, and update the ❓ rows above.

### M0 run — 2026-10-01 — Twenty v2.43.0 — `http://localhost:3000` (self-hosted, TrueNAS VM, Node 24) — **app installed; 7 PASS · 0 FAIL · 1 INFO · 2 SKIP · 8 MANUAL**

The report header said `Twenty unknown` because neither `FOLD_M0_TWENTY_VERSION` nor `TWENTY_TAG` was exported; the version is the pinned image tag. The
role of the API key used was **not recorded** (re-run with the "The Fold service account" key to test least privilege). The harness deletes the records it creates.

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
