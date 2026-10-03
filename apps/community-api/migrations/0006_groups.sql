-- SPDX-License-Identifier: AGPL-3.0-or-later
-- 0006 groups in the portal (ADR 0008): what a member needs to choose a group. Copied from Twenty's
-- churchGroup by the same sync as people (webhook hint -> refetch, hourly reconcile).
ALTER TABLE group_read
  ADD COLUMN description text,
  ADD COLUMN schedule    text,
  ADD COLUMN capacity    integer CHECK (capacity IS NULL OR capacity >= 0);

-- A person's memberships in any status (a request, a group they left) are read on every group page; 0001's
-- index covers only ACTIVE ones.
CREATE INDEX membership_read_person ON membership_read (tenant_id, person_id) WHERE deleted_at IS NULL;
