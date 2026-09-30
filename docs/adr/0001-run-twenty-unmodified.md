# ADR 0001 — Run Twenty unmodified; ship The Fold as a Twenty app plus separate services

- Status: accepted
- Date: 2026-09-30

## Context

The Fold must be sold as multi-church SaaS and owned by its authors. Twenty is AGPL-3.0 with a
commercial carve-out for files marked `/* @license Enterprise */`, MIT for its SDK and UI
packages, and an "Application Exception" that lets software built on its published APIs, SDKs,
webhooks and app manifests use any license. It ships weekly, and minor SDK versions have
contained breaking changes.

## Decision

1. Run the **stock `twentycrm/twenty` image at a pinned tag** — no fork, no patches.
2. Ship The Fold's CRM customisation as a **Twenty app** (`apps/fold-app`, built with the MIT
   `twenty-sdk`): objects, fields, views, roles, navigation.
3. Put everything Twenty does not do — the member portal, social features, confidential care
   text, notifications, automation workers — in **our own services** (`apps/community-api`,
   `apps/portal-web`) that talk to Twenty over its REST/GraphQL APIs and webhooks.
4. Pin `twenty-sdk`, `twenty-client-sdk` and the Docker tag together; run a non-blocking weekly
   canary against the next Twenty tag.

## Consequences

- Hosting unmodified Twenty does not trigger AGPL §13 for Twenty's code; our own code is
  AGPL-3.0-or-later by choice (ADR 0005).
- We avoid features gated by the enterprise license (docs/enterprise-avoid.md). If we ever need
  one, we buy a license rather than copy or re-implement code.
- The staff UI is Twenty's own. We customise it, we do not re-skin it. Our branding lives in the
  portal and outbound email.
- Deep UI changes to Twenty are out of scope. If they become necessary, revisit this ADR: a fork
  makes our modified Twenty subject to AGPL §13 and to upstream merge cost.
- The trademark policy applies: we say "built on Twenty", never "Twenty".
- Not legal advice; counsel should confirm before the first paying church.
