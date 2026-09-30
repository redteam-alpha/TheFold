# Verification status

The single ledger of what has actually been checked. **"Unit/Property/DB tested" means the code does
what it says. It does not mean the assumption about Twenty is true.** Every row about a real Twenty
instance stays UNVERIFIED until the M0 harness (`scripts/m0/`) has been run against one and the
result recorded here.

Legend: ✅ verified here · 🟡 verified against a stand-in only · ❓ UNVERIFIED (needs real Twenty) · ⏳ not built yet

## Our own logic

| Item | Status | Evidence |
|---|---|---|
| Drift: own-rhythm threshold, eligibility, cooldowns, exclusions, household union, caps | ✅ | `packages/core/test/drift*.test.ts` (unit + fast-check) |
| Tenant attendance health and church-wide break weeks | ✅ | `drift-population.test.ts` |
| Welcomer fairness, weights, `maxOpen`, determinism | ✅ | `assignment-and-followups.test.ts` (1000-arrival simulations) |
| Escalation timings (36h / 72h) | ✅ | same |
| Identity matching, portal linking, no auto-merge | ✅ | `identity-and-care.test.ts` |
| Prayer visibility and audit rules | ✅ | same |
| Digest planning | ✅ | `digest.test.ts` |
