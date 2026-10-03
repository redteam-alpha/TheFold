-- SPDX-License-Identifier: AGPL-3.0-or-later
-- 0004 sync resume: where an interrupted reconcile stopped, inside its query.
--
-- A reconcile reads "records updated after T, oldest first" a page at a time. Restarting such a query from
-- its newest timestamp is not enough: Twenty can stamp a whole batch with the same updatedAt, and a run that
-- stops inside that group would re-read the same first pages forever. So a run records the query it was in
-- (resume_since) and Twenty's page cursor (resume_after) with every page it applies, and the next run picks
-- up from exactly there. Both are NULL when no query is in progress.
ALTER TABLE sync_cursor
  ADD COLUMN resume_since timestamptz,
  ADD COLUMN resume_after text,
  ADD CONSTRAINT sync_cursor_resume_pair CHECK ((resume_since IS NULL) = (resume_after IS NULL));
