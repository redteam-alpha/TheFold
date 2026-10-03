// SPDX-License-Identifier: AGPL-3.0-or-later
import { canDecideRequests, canSeeMembers, type GroupFacts, type OwnMembership } from './access.js';

/**
 * A group's posts (ADR 0009). Who reads, who writes, who moderates, and what a reader learns about reactions.
 * The portal asks these and nothing else.
 */

/**
 * Thanks, Praying, Care. No "Like": the point is to answer a person, not to score a post. The database keeps
 * the older name `PRAYED` for Praying.
 */
export const REACTION_KINDS = ['THANKS', 'PRAYED', 'CARE'] as const;
export type ReactionKind = (typeof REACTION_KINDS)[number];

/** Only active members read a group's posts; leaving the group ends it at once. */
export const canReadFeed = (group: GroupFacts, own: OwnMembership): boolean =>
  canSeeMembers(group, own);

/** The same people write: there are no read-only members and no posting from outside. */
export const canPost = canReadFeed;

/** The group's active leaders and co-leaders act on reports. */
export const canModerate = (group: GroupFacts, own: OwnMembership): boolean =>
  canDecideRequests(group, own);

export interface ReactionSummary {
  /** The viewer's own reaction, so they can change or take it back. */
  mine: ReactionKind | null;
  /**
   * How many people reacted, by kind: only for the person who wrote the post, so they know they were heard.
   * Nobody else sees a number, and nobody sees who reacted (no counters to compete on; CLAUDE.md rule 5).
   */
  counts: Record<ReactionKind, number> | null;
}

export function reactionSummary(
  viewerPersonId: string,
  authorPersonId: string,
  reactions: readonly { personId: string; kind: ReactionKind }[],
): ReactionSummary {
  const mine = reactions.find((r) => r.personId === viewerPersonId)?.kind ?? null;
  if (viewerPersonId !== authorPersonId) return { mine, counts: null };
  const counts: Record<ReactionKind, number> = { THANKS: 0, PRAYED: 0, CARE: 0 };
  const seen = new Set<string>();
  for (const r of reactions) {
    if (seen.has(r.personId) || r.personId === authorPersonId) continue; // one per person; not your own
    seen.add(r.personId);
    counts[r.kind]++;
  }
  return { mine, counts };
}

export type ContentStatus = 'PUBLISHED' | 'PENDING_APPROVAL' | 'REMOVED';

/**
 * What a reader sees of a post or comment. Removed content shows as "removed" to everyone; only its author
 * still sees the words, so they know what was taken down. Content waiting for approval is the author's alone.
 */
export function visibleText(
  viewerPersonId: string,
  item: { authorPersonId: string; status: ContentStatus; body: string },
): { text: string | null; removed: boolean; pending: boolean } | null {
  const own = item.authorPersonId === viewerPersonId;
  if (item.status === 'PENDING_APPROVAL')
    return own ? { text: item.body, removed: false, pending: true } : null;
  if (item.status === 'REMOVED')
    return { text: own ? item.body : null, removed: true, pending: false };
  return { text: item.body, removed: false, pending: false };
}
