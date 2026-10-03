# ADR 0009 — The group feed: members only, no counters, leaders moderate

- Status: accepted
- Date: 2026-10-03

## Context

Groups (ADR 0008) give members a place to belong. Between meetings they need somewhere to talk: "soup on
Tuesday?", "my mum is in hospital", "thank you for last night". Social feeds that rank and count posts
reward performance over care, and unmoderated spaces hurt the people they are meant to hold
(docs/research, privacy-and-safety.md). Migration 0003 created `post`, `comment`, `reaction`, `report` and
`moderation_action`; nothing used them.

## Decision

**Who reads and writes** (`packages/core/src/groups/feed.ts`, property-tested):

- Only **active members** of a group read its posts, and the same people write them (`canReadFeed`, `canPost`).
- Leaving the group ends access at once, though an author can still remove their own words.
- Outside the group, and in other churches, a post's address answers "not found".
- The words stay in community-api. Nothing goes to Twenty.

**What it looks like:**

- Posts are newest first and comments oldest first, both plain text with line breaks kept.
- Paging uses `(created_at, id)`, because ids are random rather than time-ordered (migration 0007).
- Authors appear as first name and last initial; a deleted person shows as "A former member".
- There are no images, no links rendered as links, and no editing yet.
- Limits:
  - posts up to 5000 characters and comments up to 2000;
  - per person, 10 posts and 60 comments an hour.

**Reactions:**

- The kinds are **Thanks**, **Praying** and **Care**, with no "Like". Each person has one reaction per post and can
  take it back, and nobody can react to their own post.
- Each reader sees their own reaction.
- Only the **author** sees how many people responded, by kind ("Only you see this: 1 Praying, 1 Care"), so they know
  they were heard.
- No one sees who reacted, no one else sees a number, and nothing is ranked (CLAUDE.md rule 5).

**Kindness and moderation:**

- The post form carries one plain sentence: "Write as you would speak to someone at the table…". It is a reminder,
  not a filter or a score.
- Authors can remove their own posts and replies.
- Any member can **report** a post or reply with a short reason, once.
- The group's active leaders and co-leaders see open reports: the words, the author and the reason, but **not who
  reported** (people should not fear reporting). The audit log keeps who did.
- A leader answers **Remove it** (the content and every open report on it close) or **Keep it** (only that report
  closes). Each answer writes `moderation_action` and the audit log.
- Removed content shows as "removed" to everyone, except that its author still sees their own words.

## Consequences

- A leader can be reported, and a leader would then judge a report about themselves. Church-wide moderators
  (`moderator` role, `moderator_rotation`) are the next step for that.
- Nobody is told about new posts or replies yet: notifications and email digests come with M4. Until then people
  look at the page.
- Church-wide posts (staff announcements), editing, images and prayer requests (their own tiers, `canViewPrayer`)
  are not in this step.
