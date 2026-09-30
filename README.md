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

Early scaffold (milestones M0–M1 of the plan in [`docs/`](docs)). What exists today:

- `packages/core` — the pure domain logic, fully tested: drift detection, welcomer assignment, follow-up escalation, identity matching, prayer-request visibility, notification digests.
- `packages/shared`, `packages/twenty-client`, `apps/community-api`, `apps/fold-app` — see each directory's notes and `docs/verification-status.md` for what is and is not verified against a real Twenty instance.

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
pnpm check          # SPDX headers, lint, typecheck, tests
```

Database tests need PostgreSQL 16: `scripts/dev-pg.sh start` prints the environment variables to export.

## Principles (please read before contributing)

Read [`docs/research/church-and-community-practices.md`](docs/research/church-and-community-practices.md) and [`docs/privacy-and-safety.md`](docs/privacy-and-safety.md). Short version: no leaderboards, no peer-visible "who's missing", no ranked feeds, no automated messages pretending to be personal, no sensitive text in the CRM, and minors are safe by default.

## License

[AGPL-3.0-or-later](LICENSE). See [NOTICE](NOTICE) for the relationship to Twenty and the OSSN clean-room statement, and [CLA.md](CLA.md) (draft) for contributions.
