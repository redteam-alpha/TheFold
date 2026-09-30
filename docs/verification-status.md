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
| Lint, typecheck and unit tests (Node 22 and 24) and the PostgreSQL 16 database tests are green **on GitHub Actions** | ❓ | They pass locally (`pnpm check`), which is not the same as CI. The first two CI runs failed at setup, before any test ran: `pnpm/action-setup` refused because the pnpm version was declared in both `ci.yml` and `package.json`. Fixed by removing it from `ci.yml`; awaiting the re-run |
| The app **installs** with the pinned SDK on **Node 24** | ❓ | M0 manual `app-install`. The SDK declares `engines: node ^24.5.0`; we only typechecked/validated under Node 22 |

## 4. Assumptions about a running Twenty (M0 must answer these)

Each row names the harness check and the **one place** in our code that changes if the answer is "no".

| Assumption | Status | Harness check | If wrong, change |
|---|---|---|---|
| REST list/create/update/delete paths and response shapes (`/rest/<plural>`, `{data:{…}}`, `pageInfo`) | ❓ (🟡 against the fake) | `auth-and-rest`, `batch-limit-and-paging` | `unwrapRecords`, `nextCursorOf`, `listUpdatedSince` in `twenty-client/src/client.ts` |
| Filter syntax `sourceRef[eq]:"…"`, `updatedAt[gt]:"…"`, `order_by`, `starting_after` | ❓ | `sourceref-idempotent`, `batch-limit-and-paging` | REST adapter section of `client.ts`. **A server that ignores the filter would silently lose data; the harness has a check for exactly that** |
| `sourceRef` uniqueness (`isUnique`) holds on custom objects and on Person | ❓ | `sourceref-idempotent` | `scalarField` in `apps/fold-app/src/model/build.ts` |
| SELECT defaults written as `"'OPEN'"` apply as intended (not stored with quotes) | ❓ | `select-defaults` | `scalarField` (SELECT case) |
| `defineField` can extend the standard Person object; self-relations on Person work | ❓ | `app-installed`; manual `self-relations` | `personFieldConfigs`, `RELATIONS` |
| Person accepts composite `emails`/`phones` payloads and relations set through `<field>Id` (`householdId`, `guardianId`) | ❓ (🟡 against the fake) | `person-shapes` | `RestTwentyGateway` in `apps/community-api/src/twenty/gateway.ts` |
| Batch endpoint `/rest/batch/<plural>` and its 60-record limit | ❓ | `batch-limit-and-paging`, `batch-61` | `MAX_BATCH` / `batchCreate` |
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

*No run recorded yet.* After running `pnpm m0`, paste the generated table here (newest first) with the date and the
Twenty version, and update the ❓ rows above.
