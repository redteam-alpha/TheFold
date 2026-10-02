-- SPDX-License-Identifier: AGPL-3.0-or-later
-- 0005 portal sessions: a member's browser session after an emailed sign-in link (ADR 0007).
--
-- Only a SHA-256 of the cookie's token is stored, as for magic_link: a copy of this table cannot sign anyone in.
-- A session belongs to a portal account, never directly to a person: what an account may see is decided at
-- each request from its person_link, so a link staff reject or a person deleted in Twenty takes effect at once.

CREATE TABLE portal_session (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant (id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  token_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  UNIQUE (tenant_id, token_hash),
  FOREIGN KEY (tenant_id, account_id) REFERENCES portal_account (tenant_id, id) ON DELETE CASCADE,
  CHECK (expires_at > created_at)
);
SELECT fold_enable_tenant_rls('portal_session');

-- The per-address throttle counts recent links for one email.
CREATE INDEX magic_link_recent ON magic_link (tenant_id, email, created_at);
