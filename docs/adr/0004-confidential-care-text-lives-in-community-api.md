# ADR 0004 — Confidential care and prayer text lives in community-api, not Twenty

- Status: accepted
- Date: 2026-09-30

## Context

Prayer requests and care notes are religion-related personal data (GDPR Art. 9 special category)
and are often the most sensitive thing a person ever writes to their church. Twenty's row-level
permissions are enterprise-licensed; its object- and field-level permissions are not. Twenty's
notes, timeline, search and export sit outside the permissions of custom objects, and workflow
actions may not honour role permissions (to be verified in M0).

## Decision

- **Free text of prayer requests and care notes is stored only in `community-api`**, encrypted
  with a per-tenant data key (envelope encryption), and never in Twenty.
- Twenty's `CareRequest` holds **metadata only**: status, owner, priority, coarse category,
  dates, and an opaque `communityRef`. Its `contextSummary` fields are system-generated and
  non-sensitive.
- Access is decided in one function, `canViewPrayer` (packages/core): the author, the assigned
  care-team member, a pastor with assignment or a written break-glass reason. Every read through
  the care path writes an append-only `audit_log` row.
- Visibility tiers are `CARE_ONLY`, `GROUP`, `CHURCH`. There is no public tier and no default.
- Members can see how many care-team members viewed their request ("How we care" page).

## Consequences

- Staff open a care item in Twenty, follow a deep link into the portal, and authenticate there
  (passkey). That extra hop is intentional.
- Erasure and export for a person cascade through both systems (DSAR jobs).
