# Privacy and safety commitments

These are product requirements, not aspirations. Each has a place in the code or a test, listed
in the right-hand column. Not legal advice: religion is special-category data under GDPR Art. 9,
COPPA's amended rule is in force (compliance date 2026-04-22), and background checks fall under the
FCRA. Counsel must review before the first paying church.

| Commitment | Where it lives |
|---|---|
| Prayer and care **text is never stored in Twenty** | ADR 0004; `apps/community-api` schema |
| One function decides who reads a prayer request; care reads are audited | `canViewPrayer` (packages/core), `audit_log` (append-only) |
| Prayer visibility has **no public tier and no default** | `PRAYER_TIERS`; composer requires an explicit choice |
| Anonymous-to-community still shows the author to the care team, and the UI says so | `showAuthor` in `canViewPrayer` |
| Requests expire after 90 days with a prompt to update, answer or archive | `prayer_request.expires_at` |
| Members can see how many care-team members viewed their request | "How we care" page (M3) |
| Drift check-ins **never send anything to the person** and never use message or prayer content | `evaluateDrift` returns a decision for a shepherd only |
| No individual score or "risk" grade is ever emitted or displayed | `DriftResult` has no score; `orderingRatio` is queue-order only |
| Minors are never evaluated for drift on their own | `resolveDriftUnits`, `evaluateDrift` |
| Minors get no portal accounts; no adult-to-minor direct messages | `decidePortalLink`; DM design (M6) |
| Background checks are stored as status + date only | Person fields |
| Do-not-contact is honoured by every automated path | `evaluateDrift`, `resolveDriftUnits` |
| Digest by default, quiet hours, daily cap; confidential items redacted | `planDelivery` |
| Email is sent only by community-api with unsubscribe and bounce handling | M4 |
| Export and erase cascade from Person deletion across Twenty and community-api | DSAR jobs (M3+) |
| Every tenant table has row-level security; cross-tenant reads are tested | migrations + schema test |
| Metrics measure the church's follow-through, never rank people | `docs/metrics.md` |

## Never build

Leaderboards or streaks · giving-weighted engagement scores · peer-visible "who's missing" lists ·
ranked or infinite feeds · auto-sent "we missed you" messages posing as personal · third-party data
enrichment · open member search exposing minors · individual risk grades outside the care team.

## Test data

Never put real congregants' names, prayer requests or care notes in fixtures, issues or screenshots.
