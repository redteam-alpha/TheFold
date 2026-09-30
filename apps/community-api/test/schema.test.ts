// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  GROUP_OPENNESS,
  GROUP_ROLES,
  LIFECYCLE_STAGES,
  MEMBERSHIP_STATUSES,
  NOTIFICATION_CATEGORIES,
  PRAYER_STATUSES,
  PRAYER_TIERS,
  STAFF_ROLES,
} from '@thefold/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, dbAvailable, seedTenant, type TestDb } from './helpers/db.js';
import { withTenant } from '../src/db/tenant.js';

describe.skipIf(!dbAvailable)('schema rules', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db.drop();
  });

  /** Tables that legitimately have no tenant_id. */
  const NOT_TENANT_SCOPED = new Set(['tenant', 'schema_migrations']);

  it('every tenant table has tenant_id, ENABLE + FORCE row-level security, and the tenant_isolation policy', async () => {
    const { rows } = await db.ownerPool.query<{
      table_name: string;
      has_tenant_id: boolean;
      rls: boolean;
      forced: boolean;
      policy: string | null;
    }>(`
      SELECT c.relname AS table_name,
             EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped) AS has_tenant_id,
             c.relrowsecurity AS rls,
             c.relforcerowsecurity AS forced,
             (SELECT p.polname FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS policy
        FROM pg_class c
       WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
       ORDER BY c.relname`);
    const scoped = rows.filter((r) => !NOT_TENANT_SCOPED.has(r.table_name));
    expect(scoped.length).toBeGreaterThan(25);
    const failures = scoped.filter(
      (r) => !(r.has_tenant_id && r.rls && r.forced && r.policy === 'tenant_isolation'),
    );
    expect(failures.map((f) => f.table_name)).toEqual([]);
  });

  it('the tenant table lets fold_app read only, and only its own row', async () => {
    const t = await db.ownerPool.query(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'tenant'`,
    );
    expect(t.rows[0]).toEqual({ relrowsecurity: true });
    const priv = await db.ownerPool.query<{ p: string }>(
      `SELECT privilege_type AS p FROM information_schema.role_table_grants WHERE grantee = 'fold_app' AND table_name = 'tenant'`,
    );
    expect(priv.rows.map((r) => r.p)).toEqual(['SELECT']);
  });

  it('fold_app cannot bypass RLS, is not a superuser, owns nothing and cannot run DDL', async () => {
    const role = await db.ownerPool.query(
      `SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = 'fold_app'`,
    );
    expect(role.rows[0]).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
    });
    const owned = await db.ownerPool.query(
      `SELECT count(*)::int AS n FROM pg_tables WHERE tableowner = 'fold_app'`,
    );
    expect(owned.rows[0]).toEqual({ n: 0 });
    await expect(db.appPool.query('CREATE TABLE sneaky (id int)')).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      db.appPool.query('ALTER TABLE person_read DISABLE ROW LEVEL SECURITY'),
    ).rejects.toThrow(/must be owner/);
    await expect(db.appPool.query('DROP POLICY tenant_isolation ON person_read')).rejects.toThrow(
      /must be owner/,
    );
  });

  it('cross-table foreign keys always include tenant_id, so a row can never reference another tenant', async () => {
    const { rows } = await db.ownerPool.query<{ tbl: string; ref: string; cols: string[] }>(`
      SELECT c.conrelid::regclass::text AS tbl, c.confrelid::regclass::text AS ref,
             (SELECT array_agg(a.attname::text) FROM unnest(c.conkey) k
                JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k) AS cols
        FROM pg_constraint c
       WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace`);
    const crossTable = rows.filter((r) => r.ref !== 'tenant');
    expect(crossTable.length).toBeGreaterThan(3);
    expect(
      crossTable.filter((r) => !r.cols.includes('tenant_id')).map((r) => `${r.tbl} -> ${r.ref}`),
    ).toEqual([]);
  });

  describe('database CHECK constraints stay in sync with the domain enums in packages/core', () => {
    const cases: [string, string, readonly string[]][] = [
      ['person_read', 'lifecycle_stage', LIFECYCLE_STAGES],
      ['group_read', 'openness', GROUP_OPENNESS],
      ['membership_read', 'role', GROUP_ROLES],
      ['membership_read', 'status', MEMBERSHIP_STATUSES],
      ['staff_role_assignment', 'role', STAFF_ROLES],
      ['prayer_request', 'tier', PRAYER_TIERS],
      ['prayer_request', 'status', PRAYER_STATUSES],
      ['notification', 'category', NOTIFICATION_CATEGORIES],
    ];
    it.each(cases)('%s.%s', async (table, column, expected) => {
      const { rows } = await db.ownerPool.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'c'`,
        [table],
      );
      const def = rows
        .map((r) => r.def)
        .find((d) => new RegExp(`\\(?\\(?${column}\\s*=\\s*ANY`).test(d));
      expect(def, `no CHECK ... IN (...) on ${table}.${column}`).toBeDefined();
      const actual = [...(def as string).matchAll(/'([A-Za-z_]+)'::text/g)].map(
        (m) => m[1] as string,
      );
      expect([...actual].sort()).toEqual([...expected].sort());
    });
  });

  it('audit_log, consent_log, care_note and moderation_action cannot be rewritten by the app', async () => {
    const t = await seedTenant(db, 'append-only');
    await withTenant(db.appPool, t.id, async (c) => {
      await c.query(
        `INSERT INTO audit_log (tenant_id, action, subject_type) VALUES (fold_current_tenant(), 'X', 'Y')`,
      );
      await c.query(
        `INSERT INTO consent_log (tenant_id, person_id, kind, version, granted, source) VALUES (fold_current_tenant(), gen_random_uuid(), 'k', 'v', true, 's')`,
      );
    });
    for (const sql of [
      `UPDATE audit_log SET action = 'tampered'`,
      `DELETE FROM audit_log`,
      `UPDATE consent_log SET granted = false`,
      `DELETE FROM consent_log`,
    ]) {
      await expect(
        withTenant(db.appPool, t.id, (c) => c.query(sql)),
        sql,
      ).rejects.toThrow(/permission denied/);
    }
  });

  it('even the schema owner cannot rewrite the audit log: FORCE RLS hides it, and a trigger blocks it if the tenant is set', async () => {
    const t = await seedTenant(db, 'owner-trigger');
    await withTenant(db.appPool, t.id, (c) =>
      c.query(
        `INSERT INTO audit_log (tenant_id, action, subject_type) VALUES (fold_current_tenant(), 'X', 'Y')`,
      ),
    );

    // Without a tenant context the owner sees nothing at all (FORCE ROW LEVEL SECURITY applies to owners too).
    const blind = await db.ownerPool.query(`UPDATE audit_log SET action = 'tampered'`);
    expect(blind.rowCount).toBe(0);

    // Even with the tenant context set, the append-only trigger refuses.
    const owner = await db.ownerPool.connect();
    try {
      await owner.query('BEGIN');
      await owner.query(`SELECT set_config('app.tenant_id', $1, true)`, [t.id]);
      await expect(owner.query(`UPDATE audit_log SET action = 'tampered'`)).rejects.toThrow(
        /append-only/,
      );
      await owner.query('ROLLBACK');
      await owner.query('BEGIN');
      await owner.query(`SELECT set_config('app.tenant_id', $1, true)`, [t.id]);
      await expect(owner.query(`DELETE FROM audit_log`)).rejects.toThrow(/append-only/);
      await owner.query('ROLLBACK');
    } finally {
      owner.release();
    }
    const still = await withTenant(db.appPool, t.id, (c) =>
      c.query(`SELECT action FROM audit_log`),
    );
    expect(still.rows).toEqual([{ action: 'X' }]);
  });

  it('prayer requests cannot be stored without a tier, with a PUBLIC tier, or care-only without a follow-up', async () => {
    const t = await seedTenant(db, 'prayer-constraints');
    const insert = (tier: string | null, extra: { group?: string | null; follow?: boolean } = {}) =>
      withTenant(db.appPool, t.id, (c) =>
        c.query(
          `INSERT INTO prayer_request (tenant_id, author_person_id, body_ciphertext, tier, group_id, anonymous_to_community,
                                       about_someone_else, follow_up_wanted, consent_version, consented_at, expires_at)
           VALUES (fold_current_tenant(), gen_random_uuid(), '\\x00', $1, $2, false, false, $3, 'v1', now(), now() + interval '90 days')`,
          [tier, extra.group ?? null, extra.follow ?? false],
        ),
      );
    await expect(insert(null)).rejects.toThrow(/null value/);
    await expect(insert('PUBLIC')).rejects.toThrow(/check constraint/);
    await expect(insert('CARE_ONLY', { follow: false })).rejects.toThrow(/check constraint/);
    await expect(insert('GROUP')).rejects.toThrow(/check constraint/);
    await expect(
      insert('CHURCH', { group: '3f0c1b9e-8a44-4b62-9d6e-1c2b3a4d5e6f' }),
    ).rejects.toThrow(/check constraint/);
    await expect(insert('CHURCH')).resolves.toBeDefined();
    await expect(insert('CARE_ONLY', { follow: true })).resolves.toBeDefined();
  });
});
