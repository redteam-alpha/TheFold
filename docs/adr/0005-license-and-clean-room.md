# ADR 0005 — AGPL-3.0-or-later for our code; OSSN ideas only, clean-room

- Status: accepted
- Date: 2026-09-30

## Decision

- All Fold source is **AGPL-3.0-or-later** (SPDX header on every source file, checked in CI).
  The repository started as GPL-3.0; the owner chose AGPL so that anyone hosting a modified
  version for users must share their changes.
- A **CLA** (draft, needs counsel review) lets the owner keep the option to dual-license.
- **OSSN is a design reference, not a dependency.** Its core is under CAL-1.0, which is not
  compatible with the AGPL for combined works and carries obligations (for example on user data
  and sublicensing) that the AGPL forbids adding. No OSSN code, SQL, templates or translations
  are copied. See NOTICE.
- Dependencies under CAL-1.0, SSPL or GPL-only licenses are rejected by CI.

## Consequences

- Contributors must design from behaviour, not from OSSN's source.
- Reusing an OSSN feature means re-specifying and re-implementing it.
- Not legal advice; confirm with counsel before the first paying church.
