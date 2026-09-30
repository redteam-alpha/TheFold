-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Cluster-level roles for the community database. Idempotent. Run once per cluster as a superuser.
--
--   fold_migrator  owns the schema; used only by the migration runner. Never used by the running app.
--   fold_app       used by the API and workers. Not an owner, cannot bypass row-level security,
--                  and only holds the table privileges each migration grants it.
--
-- Passwords are set out-of-band in real deployments (ALTER ROLE ... PASSWORD ...). The dev/test
-- cluster from scripts/dev-pg.sh uses trust authentication and needs none.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fold_migrator') THEN
    CREATE ROLE fold_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fold_app') THEN
    CREATE ROLE fold_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;
