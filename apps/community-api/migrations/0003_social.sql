-- SPDX-License-Identifier: AGPL-3.0-or-later
-- 0003 social: a deliberately small, chronological community layer.
--
-- Designed from behaviour (groups, visibility levels, reactions, notifications), not from any
-- other project's schema. Feeds are bounded by membership -- `audience = 'CHURCH'` or one of the
-- viewer's groups -- and paged by keyset on id; there is no ranking and no friend fan-out.

CREATE TABLE post (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  author_person_id uuid NOT NULL,
  audience         text NOT NULL CHECK (audience IN ('CHURCH', 'GROUP')),
  group_id         uuid,
  kind             text NOT NULL DEFAULT 'POST' CHECK (kind IN ('POST', 'ANNOUNCEMENT', 'EVENT_CARD', 'PRAYER_ANSWERED_CARD')),
  body             text NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  link_type        text,
  link_id          uuid,
  status           text NOT NULL DEFAULT 'PUBLISHED' CHECK (status IN ('PENDING_APPROVAL', 'PUBLISHED', 'REMOVED')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  edited_at        timestamptz,
  UNIQUE (tenant_id, id),
  CHECK ((audience = 'GROUP') = (group_id IS NOT NULL)),
  CHECK ((link_type IS NULL) = (link_id IS NULL))
);
-- uuidv7 ids sort by time, so (tenant, audience, group, id DESC) is the chronological feed.
CREATE INDEX post_feed ON post (tenant_id, audience, group_id, id DESC) WHERE status = 'PUBLISHED';
SELECT fold_enable_tenant_rls('post');

CREATE TABLE comment (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  post_id          uuid NOT NULL,
  parent_id        uuid,
  author_person_id uuid NOT NULL,
  body             text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  status           text NOT NULL DEFAULT 'PUBLISHED' CHECK (status IN ('PUBLISHED', 'REMOVED')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, post_id) REFERENCES post (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, parent_id) REFERENCES comment (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX comment_by_post ON comment (tenant_id, post_id, id);
SELECT fold_enable_tenant_rls('comment');

-- One reaction of one kind per person per subject. "PRAYED" backs "I prayed" on posts; prayer
-- requests use prayer_reaction so a request's author only ever sees a count.
CREATE TABLE reaction (
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  subject_type text NOT NULL CHECK (subject_type IN ('POST', 'COMMENT')),
  subject_id   uuid NOT NULL,
  person_id    uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('LIKE', 'PRAYED', 'THANKS', 'CARE')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, subject_type, subject_id, person_id)
);
SELECT fold_enable_tenant_rls('reaction', 'SELECT, INSERT, UPDATE, DELETE');

-- (type, actor, recipient, subject, item, viewed) -- plus a delivery channel decided by notification_pref.
CREATE TABLE notification (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  recipient_person_id uuid NOT NULL,
  category            text NOT NULL CHECK (category IN ('SECURITY', 'FOLLOW_UP_DUE', 'CARE_ASSIGNMENT', 'DIRECT_REPLY', 'QUESTION_ANSWER', 'EVENT_REMINDER', 'GROUP_ACTIVITY', 'PRAYER', 'ANNOUNCEMENT')),
  type                text NOT NULL,
  actor_person_id     uuid,
  subject_type        text,
  subject_id          uuid,
  item_id             uuid,
  sensitive           boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  read_at             timestamptz,
  emailed_at          timestamptz
);
CREATE INDEX notification_inbox ON notification (tenant_id, recipient_person_id, read_at NULLS FIRST, id DESC);
CREATE INDEX notification_unsent ON notification (tenant_id, recipient_person_id, created_at) WHERE emailed_at IS NULL;
SELECT fold_enable_tenant_rls('notification');

CREATE TABLE notification_pref (
  tenant_id  uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  person_id  uuid NOT NULL,
  category   text NOT NULL,
  mode       text NOT NULL CHECK (mode IN ('IMMEDIATE', 'DIGEST', 'OFF')),
  PRIMARY KEY (tenant_id, person_id, category)
);
SELECT fold_enable_tenant_rls('notification_pref');

CREATE TABLE digest_run (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  person_id  uuid NOT NULL,
  sent_at    timestamptz NOT NULL DEFAULT now(),
  item_count integer NOT NULL CHECK (item_count > 0)
);
CREATE INDEX digest_run_last ON digest_run (tenant_id, person_id, sent_at DESC);
SELECT fold_enable_tenant_rls('digest_run', 'SELECT, INSERT');

-- Moderation: members can report; moderators act; every action is recorded.
CREATE TABLE report (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  reporter_person_id uuid NOT NULL,
  subject_type       text NOT NULL CHECK (subject_type IN ('POST', 'COMMENT', 'PRAYER_REQUEST', 'PERSON')),
  subject_id         uuid NOT NULL,
  reason             text NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  status             text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ACTIONED', 'DISMISSED')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX report_open ON report (tenant_id, created_at) WHERE status = 'OPEN';
SELECT fold_enable_tenant_rls('report');

CREATE TABLE moderation_action (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  report_id           uuid,
  moderator_person_id uuid NOT NULL,
  action              text NOT NULL CHECK (action IN ('REMOVE', 'RESTORE', 'WARN', 'DISMISS', 'APPROVE')),
  subject_type        text NOT NULL,
  subject_id          uuid NOT NULL,
  note                text,
  at                  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, report_id) REFERENCES report (tenant_id, id)
);
CREATE TRIGGER moderation_action_append_only BEFORE UPDATE OR DELETE ON moderation_action
  FOR EACH ROW EXECUTE FUNCTION fold_reject_mutation();
SELECT fold_enable_tenant_rls('moderation_action', 'SELECT, INSERT');

-- Moderation is shared and rotated so no one burns out (a documented cause of community failure).
CREATE TABLE moderator_rotation (
  tenant_id  uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  person_id  uuid NOT NULL,
  week_start date NOT NULL,
  PRIMARY KEY (tenant_id, week_start, person_id)
);
SELECT fold_enable_tenant_rls('moderator_rotation');
