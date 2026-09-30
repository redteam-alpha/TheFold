# ADR 0002 — Tenancy: one church per tenant, "cells" by default

- Status: accepted (revisit after the M0 spike)
- Date: 2026-09-30

## Context

The Fold is multi-church SaaS from day one. Twenty has a multi-workspace mode
(`IS_MULTIWORKSPACE_ENABLED`, subdomains), but three things are unverified: whether it is
licensed or gated for self-hosters, whether workspace creation can be scripted, and how much
blast radius one shared Twenty gives us for religion-related personal data (GDPR Art. 9).

## Decision

- A church is a **tenant**. Each tenant maps to one `TenantRuntime` (`twentyBaseUrl`, an
  encrypted scoped API key, a subdomain) and one `tenant_id` in the community database.
- The provisioner targets the `TenantRuntime` interface and supports two implementations:
  a workspace on a shared Twenty, or a **cell** (a dedicated Twenty server + database).
- **Default to cells** until M0 proves multi-workspace is licensed and scriptable. Cells can
  share Postgres and Redis servers using separate databases.
- The community database isolates tenants with PostgreSQL row-level security (`FORCE ROW LEVEL
  SECURITY`, non-owner application role without `BYPASSRLS`, tenant set per transaction with
  `SET LOCAL`). Cross-tenant reads are verified by tests, not trusted.
- Background workers iterate tenants explicitly through a `SECURITY DEFINER` listing function;
  nothing runs with a role that bypasses RLS.

## Consequences

- Cells cost more per church than workspaces; that is an operational lever, not a code change.
- Every table needs `tenant_id` and a policy; a schema test fails CI if one is missing.
