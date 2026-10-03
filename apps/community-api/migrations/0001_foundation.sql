-- SPDX-License-Identifier: AGPL-3.0-or-later
-- 0001 foundation: tenancy, identity, read models of Twenty data, the sync pipeline, audit.
--
-- Rules for every table in this database:
--   * it has tenant_id and goes through fold_enable_tenant_rls() (ENABLE + FORCE row-level security,
--     tenant_isolation policy, grants to fold_app). test/schema.test.ts fails CI if one is missed;
--   * cross-table references inside a tenant are composite (tenant_id, id) so a row can never point
--     at another tenant's row, even if application code is wrong;
--   * timestamps are timestamptz; calendar days are date.

-- The current tenant for this transaction. Set by the app with set_config('app.tenant_id', $1, true).
-- Unset (or empty) yields NULL, so every policy evaluates to NULL and denies: fail closed.
CREATE FUNCTION fold_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

-- Applies the standard tenant policy and grants to fold_app.
CREATE FUNCTION fold_enable_tenant_rls(tbl regclass, privileges text DEFAULT 'SELECT, INSERT, UPDATE, DELETE')
  RETURNS void
  LANGUAGE plpgsql
  AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s USING (tenant_id = fold_current_tenant()) WITH CHECK (tenant_id = fold_current_tenant())',
    tbl);
  EXECUTE format('GRANT %s ON %s TO fold_app', privileges, tbl);
END
$$;

-- Append-only guard for audit-style tables.
CREATE FUNCTION fold_reject_mutation() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Tenants. The only table without tenant_id: a tenant can see only its own row. It is ENABLE (not
-- FORCE) so the SECURITY DEFINER lookups below, owned by the migrator, can see every tenant.
-- fold_app can never insert or update tenants; provisioning is a privileged operation.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE tenant (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'),
  subdomain       text NOT NULL UNIQUE CHECK (subdomain ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'),
  name            text NOT NULL,
  timezone        text NOT NULL DEFAULT 'UTC',
  twenty_base_url text NOT NULL,
  status          text NOT NULL DEFAULT 'PROVISIONING' CHECK (status IN ('PROVISIONING', 'ACTIVE', 'SUSPENDED')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenant FOR SELECT USING (id = fold_current_tenant());
GRANT SELECT ON tenant TO fold_app;

-- Workers iterate tenants explicitly; nothing runs with a role that bypasses RLS.
CREATE FUNCTION fold_list_active_tenant_ids() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ SELECT id FROM public.tenant WHERE status = 'ACTIVE' ORDER BY id $$;

-- Resolves the request's subdomain to a tenant before a tenant context exists.
CREATE FUNCTION fold_tenant_id_for_subdomain(p_subdomain text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ SELECT id FROM public.tenant WHERE subdomain = lower(p_subdomain) AND status = 'ACTIVE' $$;

REVOKE ALL ON FUNCTION fold_list_active_tenant_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION fold_tenant_id_for_subdomain(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fold_list_active_tenant_ids() TO fold_app;
GRANT EXECUTE ON FUNCTION fold_tenant_id_for_subdomain(text) TO fold_app;

-- Per-tenant secrets, stored only wrapped: the data-encryption key (wrapped by the KEK held outside
-- the database) and the encrypted Twenty API key. See ADR 0004.
CREATE TABLE tenant_secret (
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  name        text NOT NULL,
  key_version integer NOT NULL DEFAULT 1,
  wrapped     bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, name, key_version)
);
SELECT fold_enable_tenant_rls('tenant_secret', 'SELECT, INSERT');

-- ---------------------------------------------------------------------------------------------
-- Identity: portal accounts (members and volunteers; staff work in Twenty) linked to Twenty Persons.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE portal_account (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  email         text NOT NULL CHECK (email = lower(email) AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, email)
);
SELECT fold_enable_tenant_rls('portal_account');

CREATE TABLE passkey_credential (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  account_id    uuid NOT NULL,
  credential_id bytea NOT NULL,
  public_key    bytea NOT NULL,
  sign_count    bigint NOT NULL DEFAULT 0,
  transports    text[] NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  UNIQUE (tenant_id, credential_id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES portal_account (tenant_id, id) ON DELETE CASCADE
);
SELECT fold_enable_tenant_rls('passkey_credential');

-- Single-use, hashed, short-lived. The raw token exists only in the email.
CREATE TABLE magic_link (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  email        text NOT NULL CHECK (email = lower(email)),
  token_hash   bytea NOT NULL,
  requested_ip inet,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  UNIQUE (tenant_id, token_hash),
  CHECK (expires_at > created_at)
);
CREATE INDEX magic_link_email_recent ON magic_link (tenant_id, email, created_at DESC);
SELECT fold_enable_tenant_rls('magic_link');

-- Which Twenty Person a portal account is. Never auto-merged; ambiguous cases wait for staff.
CREATE TABLE person_link (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  account_id          uuid NOT NULL,
  twenty_person_id    uuid NOT NULL,
  status              text NOT NULL CHECK (status IN ('PENDING_REVIEW', 'VERIFIED', 'REJECTED')),
  method              text NOT NULL CHECK (method IN ('magic_link', 'qr_in_person', 'staff_confirmed')),
  confirmed_by_person uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  confirmed_at        timestamptz,
  UNIQUE (tenant_id, account_id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES portal_account (tenant_id, id) ON DELETE CASCADE,
  CHECK (status <> 'VERIFIED' OR confirmed_at IS NOT NULL)
);
-- One verified account per Person.
CREATE UNIQUE INDEX person_link_one_verified ON person_link (tenant_id, twenty_person_id) WHERE status = 'VERIFIED';
SELECT fold_enable_tenant_rls('person_link');

-- When staff merge duplicate Persons in Twenty, old ids keep resolving.
CREATE TABLE person_alias (
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  old_person_id uuid NOT NULL,
  new_person_id uuid NOT NULL,
  merged_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, old_person_id),
  CHECK (old_person_id <> new_person_id)
);
SELECT fold_enable_tenant_rls('person_alias');

-- Portal-side staff roles, managed by tenant admins. group_leader is derived from memberships, not stored.
CREATE TABLE staff_role_assignment (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  twenty_person_id   uuid NOT NULL,
  role               text NOT NULL CHECK (role IN ('admin', 'pastor', 'care_team', 'welcome_lead', 'welcomer', 'group_leader', 'moderator')),
  granted_by_person  uuid,
  granted_at         timestamptz NOT NULL DEFAULT now(),
  revoked_at         timestamptz
);
CREATE UNIQUE INDEX staff_role_active ON staff_role_assignment (tenant_id, twenty_person_id, role) WHERE revoked_at IS NULL;
SELECT fold_enable_tenant_rls('staff_role_assignment');

-- ---------------------------------------------------------------------------------------------
-- Read models of Twenty data. The portal never calls Twenty synchronously to render a page.
-- A row is only overwritten by a newer twenty_updated_at (see readModels.ts), so late or duplicate
-- webhooks and reconcile runs cannot roll data back.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE person_read (
  tenant_id         uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  twenty_person_id  uuid NOT NULL,
  twenty_updated_at timestamptz NOT NULL,
  first_name        text NOT NULL DEFAULT '',
  last_name         text NOT NULL DEFAULT '',
  emails            text[] NOT NULL DEFAULT '{}',
  phones            text[] NOT NULL DEFAULT '{}',
  is_minor          boolean NOT NULL DEFAULT false,
  shared_email      boolean NOT NULL DEFAULT false,
  household_id      uuid,
  lifecycle_stage   text NOT NULL DEFAULT 'NEW_GUEST' CHECK (lifecycle_stage IN ('NEW_GUEST', 'WELCOMED', 'GETTING_CONNECTED', 'CONNECTED', 'SERVING', 'INACTIVE', 'MOVED_AWAY', 'DECEASED')),
  do_not_contact    boolean NOT NULL DEFAULT false,
  away_until        date,
  deleted_at        timestamptz,
  synced_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, twenty_person_id)
);
CREATE INDEX person_read_emails ON person_read USING gin (emails);
CREATE INDEX person_read_household ON person_read (tenant_id, household_id) WHERE household_id IS NOT NULL;
SELECT fold_enable_tenant_rls('person_read');

CREATE TABLE group_read (
  tenant_id         uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  twenty_group_id   uuid NOT NULL,
  twenty_updated_at timestamptz NOT NULL,
  name              text NOT NULL DEFAULT '',
  group_type        text,
  openness          text NOT NULL DEFAULT 'CLOSED' CHECK (openness IN ('PUBLIC', 'CLOSED', 'SECRET')),
  child_friendly    boolean NOT NULL DEFAULT false,
  paused_until      date,
  campus_id         uuid,
  deleted_at        timestamptz,
  synced_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, twenty_group_id)
);
SELECT fold_enable_tenant_rls('group_read');

CREATE TABLE membership_read (
  tenant_id             uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  twenty_membership_id  uuid NOT NULL,
  twenty_updated_at     timestamptz NOT NULL,
  group_id              uuid NOT NULL,
  person_id             uuid NOT NULL,
  role                  text NOT NULL DEFAULT 'MEMBER' CHECK (role IN ('LEADER', 'CO_LEADER', 'MEMBER', 'HOST', 'APPRENTICE')),
  status                text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('INTERESTED', 'REQUESTED', 'ACTIVE', 'PAUSED', 'LEFT')),
  deleted_at            timestamptz,
  synced_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, twenty_membership_id)
);
CREATE INDEX membership_read_person_active ON membership_read (tenant_id, person_id) WHERE status = 'ACTIVE' AND deleted_at IS NULL;
CREATE INDEX membership_read_group ON membership_read (tenant_id, group_id);
SELECT fold_enable_tenant_rls('membership_read');

CREATE TABLE event_read (
  tenant_id         uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  twenty_event_id   uuid NOT NULL,
  twenty_updated_at timestamptz NOT NULL,
  name              text NOT NULL DEFAULT '',
  starts_at         timestamptz,
  ends_at           timestamptz,
  group_id          uuid,
  capacity          integer CHECK (capacity IS NULL OR capacity >= 0),
  deleted_at        timestamptz,
  synced_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, twenty_event_id)
);
CREATE INDEX event_read_upcoming ON event_read (tenant_id, starts_at) WHERE deleted_at IS NULL;
SELECT fold_enable_tenant_rls('event_read');

-- ---------------------------------------------------------------------------------------------
-- The sync pipeline.
-- ---------------------------------------------------------------------------------------------
-- Portal -> Twenty. The idempotency key is also written to the Twenty record's sourceRef so a retry
-- after a timeout finds the record instead of creating a second one.
CREATE TABLE outbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  kind            text NOT NULL,
  idempotency_key text NOT NULL,
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'IN_FLIGHT', 'DONE', 'DEAD')),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until    timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  done_at         timestamptz,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX outbox_due ON outbox (tenant_id, next_attempt_at) WHERE status IN ('PENDING', 'IN_FLIGHT');
SELECT fold_enable_tenant_rls('outbox');

-- Twenty -> portal. Webhooks are at-least-once and unordered, so they are only *hints* that a record
-- may have changed. Exact duplicates are dropped; the rest coalesce into one pending refetch per record.
CREATE TABLE webhook_delivery (
  tenant_id   uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  delivery_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, delivery_id)
);
SELECT fold_enable_tenant_rls('webhook_delivery', 'SELECT, INSERT, DELETE');

CREATE TABLE webhook_inbox (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  object_type   text NOT NULL,
  record_id     uuid NOT NULL,
  status        text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'DONE')),
  hits          integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  done_at       timestamptz
);
CREATE UNIQUE INDEX webhook_inbox_one_pending ON webhook_inbox (tenant_id, object_type, record_id) WHERE status = 'PENDING';
SELECT fold_enable_tenant_rls('webhook_inbox');

-- Hourly reconcile: fetch records with updatedAt > cursor, per object per tenant.
CREATE TABLE sync_cursor (
  tenant_id         uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  object_type       text NOT NULL,
  cursor_updated_at timestamptz NOT NULL DEFAULT 'epoch',
  last_run_at       timestamptz,
  PRIMARY KEY (tenant_id, object_type)
);
SELECT fold_enable_tenant_rls('sync_cursor');

-- ---------------------------------------------------------------------------------------------
-- Audit and consent: append-only. fold_app may only SELECT and INSERT, and a trigger stops
-- everyone else (including the owner) from rewriting history.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE audit_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  at              timestamptz NOT NULL DEFAULT now(),
  actor_person_id uuid,
  actor_roles     text[] NOT NULL DEFAULT '{}',
  action          text NOT NULL,
  subject_type    text NOT NULL,
  subject_id      uuid,
  via             text,
  reason          text,
  meta            jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_log_subject ON audit_log (tenant_id, subject_type, subject_id, at DESC);
CREATE INDEX audit_log_actor ON audit_log (tenant_id, actor_person_id, at DESC);
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION fold_reject_mutation();
SELECT fold_enable_tenant_rls('audit_log', 'SELECT, INSERT');

CREATE TABLE consent_log (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  at        timestamptz NOT NULL DEFAULT now(),
  person_id uuid NOT NULL,
  kind      text NOT NULL,
  version   text NOT NULL,
  granted   boolean NOT NULL,
  source    text NOT NULL
);
CREATE INDEX consent_log_person ON consent_log (tenant_id, person_id, at DESC);
CREATE TRIGGER consent_log_append_only BEFORE UPDATE OR DELETE ON consent_log
  FOR EACH ROW EXECUTE FUNCTION fold_reject_mutation();
SELECT fold_enable_tenant_rls('consent_log', 'SELECT, INSERT');

-- ---------------------------------------------------------------------------------------------
-- Operations support.
-- ---------------------------------------------------------------------------------------------
-- Welcomer capacity, so assignment can be fair without hitting Twenty.
CREATE TABLE welcomer_load (
  tenant_id         uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  twenty_person_id  uuid NOT NULL,
  campus_ids        uuid[] NOT NULL DEFAULT '{}',
  weight            numeric NOT NULL DEFAULT 1 CHECK (weight > 0),
  max_open          integer NOT NULL DEFAULT 5 CHECK (max_open >= 0),
  open_count        integer NOT NULL DEFAULT 0 CHECK (open_count >= 0),
  assigned_last_30d integer NOT NULL DEFAULT 0 CHECK (assigned_last_30d >= 0),
  last_assigned_at  timestamptz,
  away_until        date,
  PRIMARY KEY (tenant_id, twenty_person_id)
);
SELECT fold_enable_tenant_rls('welcomer_load');

-- Rotating-token QR self check-in for services and events. Only the hash is stored.
CREATE TABLE checkin_token (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('SERVICE', 'EVENT', 'GROUP')),
  ref          text,
  service_date date NOT NULL,
  token_hash   bytea NOT NULL,
  expires_at   timestamptz NOT NULL,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, token_hash)
);
SELECT fold_enable_tenant_rls('checkin_token');

-- Nightly church-level metrics (docs/metrics.md). Never per-person rankings.
CREATE TABLE metric_snapshot (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  metric       text NOT NULL,
  period_start date NOT NULL,
  period_end   date NOT NULL,
  value        numeric,
  detail       jsonb NOT NULL DEFAULT '{}',
  computed_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, metric, period_start, period_end),
  CHECK (period_end >= period_start)
);
SELECT fold_enable_tenant_rls('metric_snapshot');
