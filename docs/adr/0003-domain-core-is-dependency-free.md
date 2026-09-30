# ADR 0003 — The domain core is dependency-free

- Status: accepted
- Date: 2026-09-30

## Decision

`packages/core` contains the rules that decide how people are treated: who gets a welcome call,
who is asked to check in on whom, who may read a prayer request, which notifications are
emailed. It is pure TypeScript with **no npm dependencies and no `node:` imports**, enforced by
an ESLint `no-restricted-imports` rule (see `eslint.config.js`). Dates are calendar days
(`YYYY-MM-DD`) and instants become calendar days in exactly one place (`toLocalDate`).

## Why

- These rules must be readable and testable by people who are not framework experts, including
  pastors and reviewers of the privacy posture.
- Property-based tests (fast-check) can hammer pure functions; they cannot hammer a NestJS module.
- The same functions run in the API, the workers and, eventually, the browser.

## Consequences

- Adapters (database, Twenty, email) live in the apps; the core receives plain data and returns
  decisions. If the core needs something it does not have, the adapter passes it in.
