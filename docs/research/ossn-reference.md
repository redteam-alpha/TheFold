# Open Source Social Network (OSSN): what to learn from it, and what not to copy

Research date: 2026-09-30. **Access caveat:** the OSSN website and wiki, SPDX, opensource.org, OpenCVE,
OSV and Vulners were blocked; findings come from GitHub pages, raw files and search snippets. Code
claims are second-hand summaries. **This project copies no OSSN code (see NOTICE, ADR 0005).**

## License (not legal advice)

- Core: `LICENSE.md` titled "OSSNL 4.0" = **Cryptographic Autonomy License 1.0 (CAL-1.0)** (v5.3+; earlier
  versions under "OSSN Licence 3.x", which required a "Powered by" footer and forbade incorporation into
  proprietary software). Component manifests say "Open Source Social Network License (OSSN LICENSE)".
  No AFL-3.0 found. OSSN Premium (Events, Polls, …) looks proprietary.
- CAL-1.0 and GPL/AGPL are reported incompatible (secondary sources): CAL-1.0 §4.5's Combined Work
  Exception only applies to files the licensor has marked; §4.2.1 (User Data copies) and §7.3
  (not sublicensable) are extra terms the AGPL does not allow.
- **Conclusion: port ideas and behaviour only, clean-room.** Running an unmodified OSSN as a separate
  service would not put our code under CAL — but we chose not to run it (below).

## Architecture summary

PHP with MySQL 8/MariaDB (PDO), version 10.0 stable; procedural libraries plus `Ossn*` classes; components
with `ossn_com.xml` + `ossn_com.php`, hooks and callbacks; routing `?h=<handler>&p=<page>`. Single
maintainer on recent commits. `OssnServices` (separate) gives ~50 endpoints with one admin API key; no
OAuth, per-user tokens or webhooks seen. Storage is an entity–attribute–value model
(`ossn_object`, `ossn_entities`, `ossn_entities_metadata`, `ossn_relationships`, `ossn_annotations`).

## Feature inventory (core)

Wall/feed (chronological), profiles, mutual-friend model, groups (public/closed, join request →
owner approval; **no roles table**, moderators delegated by hook), 1:1 messaging with attachments,
in-app notifications with browser polling, reactions (since 5.2), flat comments, photos/albums, search,
static site pages, invite-a-friend, admin dashboard. **Not in core:** Events, Polls, Hashtags, Reports
(all Premium/proprietary); no email digests; no group chat; three post access levels only
(private/public/friends).

## Ideas worth porting (re-implemented, not copied)

- Groups with a request → approval → notification flow, plus what OSSN lacks: a `SECRET` tier and
  leader/co-leader/member roles.
- Post visibility levels and an `item_type`/`item_guid` link pattern (⇒ "event announced" / "prayer
  answered" cards).
- Reactions as a subtype (⇒ "I prayed").
- Notification tuple (type, actor, recipient, subject, item, viewed) — plus channel preferences and a digest.
- Post backgrounds for short verses; profile hover cards; invite-a-friend (all deferred).

## Weaknesses that argue for a fresh TypeScript implementation

EAV schema (every access filter is another join); friend-feed `IN(<friend guids>)` queries; 32-bit
epoch timestamps (2038); no conversations table; AJAX polling only; no first-class mobile API;
`md5(password+salt)` default hashing (unconfirmed for fresh installs); CSRF tokens without expiry
(unconfirmed); no RBAC or multi-tenancy; recent CVEs (search snippets: CVE-2026-41309, CVE-2025-63585,
CVE-2025-63441, CVE-2022-34961/34962/34964).

## Integration options considered

1. **Run OSSN beside Twenty and sync** — fastest social UI, but two stacks/databases, no SSO/OIDC,
   no webhooks, PHP operations for a one-maintainer project, and events/prayer/digests still to build.
2. **Port concepts into Twenty custom objects + a new TypeScript member app** — chosen. One identity
   (Person), no license conflict, real-time and mobile achievable. Most build effort.
