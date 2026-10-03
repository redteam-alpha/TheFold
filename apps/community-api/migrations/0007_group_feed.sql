-- SPDX-License-Identifier: AGPL-3.0-or-later
-- 0007 the group feed (ADR 0009).
--
-- Ids here are random (gen_random_uuid), so they do not sort by time as 0003 assumed: the feed pages by
-- (created_at, id) instead, newest first, with removed posts still in place (they show as "removed").
CREATE INDEX post_group_timeline ON post (tenant_id, group_id, created_at DESC, id DESC)
  WHERE audience = 'GROUP';

-- Comments read oldest first under their post.
CREATE INDEX comment_post_timeline ON comment (tenant_id, post_id, created_at, id);

-- Thanks, Praying and Care only: no "Like" (ADR 0009). Nothing has stored a reaction yet.
ALTER TABLE reaction DROP CONSTRAINT reaction_kind_check;
ALTER TABLE reaction ADD CONSTRAINT reaction_kind_check CHECK (kind IN ('THANKS', 'PRAYED', 'CARE'));

-- The posting limits count a person's recent posts and comments.
CREATE INDEX post_author_recent ON post (tenant_id, author_person_id, created_at);
CREATE INDEX comment_author_recent ON comment (tenant_id, author_person_id, created_at);

-- One open report per person per item: reporting twice does not shout louder.
CREATE UNIQUE INDEX report_once ON report (tenant_id, reporter_person_id, subject_type, subject_id)
  WHERE status = 'OPEN';
