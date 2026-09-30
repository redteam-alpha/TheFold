# Twenty features The Fold must not depend on

Twenty is AGPL-3.0, but files beginning `/* @license Enterprise */` are under a commercial
license and need a valid `ENTERPRISE_KEY` for production use. As of the research date
(2026-09-30) the following are gated **or reported to be gated** — treat each as UNVERIFIED until
the M0 harness has run against a real instance with no key (see `verification-status.md`).

| Feature | Status | What we do instead |
|---|---|---|
| Row-level permissions | Enterprise-gated (documented) | Object- and field-level roles; confidential text lives in community-api (ADR 0004) |
| SSO: SAML, Google Workspace, Microsoft Entra | Enterprise-gated (documented) | Staff use email/password or Google/Microsoft OAuth; members use the portal's own login |
| Custom AI providers | Enterprise-gated | Not used |
| Event logs / audit exports | Reported gated | Our own `audit_log` in community-api |
| Email group access | Reported gated | Not used |
| Record sharing (OPEN / PRIVATE / INHERITED) | Behind `IS_RECORD_SHARING_ENABLED`, off by default, design in flux | Not relied upon |
| Multi-workspace mode | Licensing UNVERIFIED | Cells first (ADR 0002) |

Rules:

1. Do not import, copy or re-implement any file marked `@license Enterprise`.
2. If a feature is needed, buy the license rather than working around it.
3. The M0 harness runs the whole app with no enterprise key and records PASS/FAIL per feature.
