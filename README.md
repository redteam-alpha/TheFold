# The Fold

> **Where people are welcomed, known, and connected.**

The Fold is an open-source church CRM and community network, built on [Twenty](https://github.com/twentyhq/twenty).

The social side helps people form relationships: discover events, meet people, explore small groups, ask questions. The CRM side helps church leaders nurture those relationships *consistently*. Together they close the gap between someone attending a service and becoming part of a community.

The platform won't create belonging by itself. It gives a church the tools to practice care more consistently — **keeping people, not attendance numbers, at the center.**

## What it helps a church do

| Job | How The Fold helps |
|---|---|
| Notice newcomers and make sure someone personally welcomes them | Connection card → a named welcomer, a 48-hour target, gentle reminders, escalation to a welcome lead (never shaming) |
| Connect people to smaller communities | Groups, events and serving opportunities discoverable in the member portal, with a warm human introduction |
| Stay connected between Sundays | Chronological group feed, prayer wall, questions inbox, digest emails (no infinite feed, no vanity counters) |
| Follow through on care | Care requests and promised check-ins each have one owner, a due date and an overdue queue; confidential text never leaves the care-controlled store |
| Notice when someone drifts | Compares a person to **their own** rhythm, asks a shepherd for a personal check-in; never sends automated "we missed you" messages and never shows a score |

## Status

Early build (milestones M0–M1 of the plan). The Twenty app installs on a live Twenty v2.43.0 and the M0 harness passes there with
fake data, including the automated care-permission check; the community service has **not** yet run against a live Twenty. See
[`docs/verification-status.md`](docs/verification-status.md) for exactly what is verified, what is only tested against a
stand-in, and what is still an assumption.

| Part | What exists |
|---|---|
| `packages/core` | The rules that decide how people are treated, dependency-free and heavily tested: baseline-relative drift detection (no scores, nothing sent to the person), welcomer assignment, follow-up escalation, identity matching, prayer-request visibility, notification digests |
| `packages/shared` | Stable Twenty identifiers (valid UUID v4, pinned by test) and validated contracts that encode the safety rules |
| `apps/community-api` | PostgreSQL with tenant row-level security, the Twenty sync pipeline (outbox, webhook inbox, read models), envelope-encrypted care storage, and the first working flow end to end: **connection card → guest created in Twenty → fair welcomer pick → follow-ups due in 48 hours / 7 days / 21 days**. Members sign in with an emailed link (ADR 0007). Runs as an HTTP API, a background worker and a one-shot `setup` (ADR 0006; `infra/README.md` section 6). Tested on a real PostgreSQL 16, including retries and lost responses |
| `packages/twenty-client` | Rate-limited, retry-safe, idempotent access to Twenty, and the **M0 harness** that checks our assumptions against a real instance |
| `apps/fold-app` | The Twenty app: 10 objects, 37 Person fields, roles (care metadata visible only to the care team, pastors and admins), views and navigation, validated by the SDK's own validators |
| `infra/` | Pinned, unmodified Twenty + the community database; refuses to start without its secrets |

Not built yet: portal sign-in and the portal's own API, the member portal UI, email delivery, the escalation sweep, and the provisioner.

## Architecture in one picture

```
 Staff (pastors, admins)          Volunteers & members
        │                                  │
   Twenty UI (stock)                 portal-web (PWA)
   + The Fold app objects/views            │
        │  REST/GraphQL, webhooks          │
        ▼                                  ▼
   Twenty server+worker  ◄──────►  community-api (Node + Postgres RLS)
   (CRM system of record)          (social, confidential care text,
                                    notifications, automation workers)
```

Twenty runs **unmodified**; The Fold is a Twenty *app* plus separate services. See [`docs/adr`](docs/adr) for why.

## Develop

Requires Node ≥ 22.12 (24 recommended, see `.nvmrc`) and pnpm 10.

```sh
pnpm install
pnpm check          # SPDX headers, dependency licenses, lint, typecheck, tests
```

Database tests need PostgreSQL 16 and are skipped without it. `eval "$(scripts/dev-pg.sh start)"` starts a throwaway
local cluster and exports `FOLD_TEST_ADMIN_URL`; set `FOLD_REQUIRE_DB=1` to make a missing database a failure (CI does).

To verify the Twenty assumptions against a real instance, follow [`infra/README.md`](infra/README.md).

## Principles (please read before contributing)

Read [`docs/research/church-and-community-practices.md`](docs/research/church-and-community-practices.md) and [`docs/privacy-and-safety.md`](docs/privacy-and-safety.md). Short version: no leaderboards, no peer-visible "who's missing", no ranked feeds, no automated messages pretending to be personal, no sensitive text in the CRM, and minors are safe by default.

## License

[AGPL-3.0-or-later](LICENSE). See [NOTICE](NOTICE) for the relationship to Twenty and the OSSN clean-room statement, and [CLA.md](CLA.md) (draft) for contributions.
