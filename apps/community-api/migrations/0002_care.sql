-- SPDX-License-Identifier: AGPL-3.0-or-later
-- 0002 care: confidential prayer requests, care notes and questions (ADR 0004).
--
-- Free text is stored ONLY here, only as ciphertext (AES-256-GCM under a per-tenant data key, see
-- src/crypto/envelope.ts), and never in Twenty. Twenty's CareRequest holds metadata and an opaque
-- reference. Reading anything through the care path is decided by canViewPrayer (packages/core) and
-- writes an audit_log row.

CREATE TABLE prayer_request (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  author_person_id       uuid NOT NULL,
  body_ciphertext        bytea NOT NULL,
  key_version            integer NOT NULL DEFAULT 1,
  -- No PUBLIC tier and no default: the author chooses who sees it.
  tier                   text NOT NULL CHECK (tier IN ('CARE_ONLY', 'GROUP', 'CHURCH')),
  group_id               uuid,
  status                 text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ANSWERED', 'EXPIRED', 'ARCHIVED', 'REMOVED')),
  anonymous_to_community boolean NOT NULL,
  about_someone_else     boolean NOT NULL,
  follow_up_wanted       boolean NOT NULL,
  assigned_care_owner_id uuid,
  care_request_ref       uuid,
  consent_version        text NOT NULL CHECK (consent_version <> ''),
  consented_at           timestamptz NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  expires_at             timestamptz NOT NULL,
  answered_at            timestamptz,
  UNIQUE (tenant_id, id),
  CHECK ((tier = 'GROUP') = (group_id IS NOT NULL)),
  CHECK (tier <> 'CARE_ONLY' OR follow_up_wanted),
  CHECK (expires_at > created_at)
);
CREATE INDEX prayer_request_feed ON prayer_request (tenant_id, tier, group_id, created_at DESC) WHERE status IN ('ACTIVE', 'ANSWERED');
CREATE INDEX prayer_request_expiring ON prayer_request (tenant_id, expires_at) WHERE status = 'ACTIVE';
CREATE INDEX prayer_request_author ON prayer_request (tenant_id, author_person_id, created_at DESC);
SELECT fold_enable_tenant_rls('prayer_request');

-- "I prayed". The author sees a count only, never names.
CREATE TABLE prayer_reaction (
  tenant_id  uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  person_id  uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, request_id, person_id),
  FOREIGN KEY (tenant_id, request_id) REFERENCES prayer_request (tenant_id, id) ON DELETE CASCADE
);
SELECT fold_enable_tenant_rls('prayer_reaction', 'SELECT, INSERT, DELETE');

-- Notes a care-team member writes about a Twenty CareRequest. Append-only: corrections are new notes.
CREATE TABLE care_note (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  care_request_ref uuid NOT NULL,
  author_person_id uuid NOT NULL,
  body_ciphertext  bytea NOT NULL,
  key_version      integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX care_note_request ON care_note (tenant_id, care_request_ref, created_at);
CREATE TRIGGER care_note_append_only BEFORE UPDATE ON care_note
  FOR EACH ROW EXECUTE FUNCTION fold_reject_mutation();
SELECT fold_enable_tenant_rls('care_note', 'SELECT, INSERT');

-- "Ask a question": a private inbox routed to a person, not a public thread.
CREATE TABLE question (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  asker_person_id      uuid,
  body_ciphertext      bytea NOT NULL,
  key_version          integer NOT NULL DEFAULT 1,
  status               text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ROUTED', 'ANSWERED', 'CLOSED')),
  routed_follow_up_ref uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  answered_at          timestamptz
);
CREATE INDEX question_open ON question (tenant_id, created_at) WHERE status IN ('OPEN', 'ROUTED');
SELECT fold_enable_tenant_rls('question');
