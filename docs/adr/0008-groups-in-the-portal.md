# ADR 0008 — Groups in the portal: who sees what, and how people join

- Status: accepted
- Date: 2026-10-03

## Context

Groups are where most church friendships form, and the first social feature after sign-in (ADR 0007). Staff
already manage groups and memberships in Twenty (`churchGroup`, `groupMembership`). Some groups are sensitive by
their very existence: a recovery group, a support group for a loss. Members must never be able to list other
members' children, and must not see who is "missing".

## Decision

**Twenty stays the record of who is in which group.**

- community-api copies `churchGroup` into `group_read` (migration 0006) with the same sync as people: webhook
  hint → refetch, and the hourly reconcile with its deletes pass.
- Everything a member does is a `twenty.upsertMembership` outbox job. There is exactly one membership per person
  per group: it is found by the pair (`and(groupId[eq]:…,personId[eq]:…)`) and created or updated. A retry after a
  lost response therefore updates rather than duplicates, without needing a `sourceRef` on the model.
- The change is written straight through to `membership_read`, so the member sees it before Twenty's echo, and any
  record from Twenty supersedes it.

**Visibility** (`packages/core/src/groups/access.ts`, property-tested):

| Who | PUBLIC / CLOSED group | SECRET group |
|---|---|---|
| Any confirmed member | listed; first names of the leaders | not listed, and its page answers 404 like a group that does not exist |
| Someone invited, asking or paused | as above, with their own status | listed, with their own status |
| An active member | the member list, as first name and last initial (`Ada L.`), leaders first | the same |
| An active leader or co-leader | the people asking to join | the same |

- Children are never listed, whatever their membership says.
- There are no counts, no "last seen" and no ranking.
- Last names never leave the server beyond their initial.

**Joining is a request.**

- Asking sets `REQUESTED`; a leader answers with "Welcome" (`ACTIVE`, `joinedAt` today) or "Not now" (`LEFT`, and
  the person may ask again later). A leader's decision is written to the audit log.
- A member can withdraw a request, decline an invitation (`INTERESTED`), or leave (`LEFT`).
- SECRET groups are never joined from the portal: their leaders and the church add people in Twenty.
- PUBLIC differs from CLOSED only as a hint for now. Letting people join PUBLIC groups directly can come later as a
  per-church setting.

**Who may do any of this:** only a signed-in account the church has linked to an adult (`VERIFIED`). An
unconfirmed account sees no group at all.

## Consequences

- A member sees a change immediately, a leader within one worker tick, and Twenty within one tick. If Twenty
  refuses the write (for example, the service role cannot create memberships), the job retries and eventually goes
  `DEAD`; the member keeps seeing their request until then.
- Still to verify against a real Twenty (ledger):
  - the `and(...)` filter;
  - the service role creating and patching memberships;
  - group sync.
- Not built yet:
  - notifying a leader of a new request, or a member of the answer (digests, M4);
  - the group feed;
  - capacity limits ("full").
