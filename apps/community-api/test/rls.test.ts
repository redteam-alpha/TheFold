// SPDX-License-Identifier: AGPL-3.0-or-later
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listActiveTenantIds, tenantIdForSubdomain, withTenant } from '../src/db/tenant.js';
import {
  createTestDatabase,
  dbAvailable,
  seedTenant,
  type SeededTenant,
  type TestDb,
} from './helpers/db.js';

describe.skipIf(!dbAvailable)('tenant isolation (row-level security)', () => {
  let db: TestDb;
  let a: SeededTenant;
  let b: SeededTenant;
  let postB: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    a = await seedTenant(db, 'church-a');
    b = await seedTenant(db, 'church-b');
    await seedTenant(db, 'church-c', { status: 'SUSPENDED' });
    for (const t of [a, b]) {
      await withTenant(db.appPool, t.id, async (c) => {
        await c.query(
          `INSERT INTO person_read (tenant_id, twenty_person_id, twenty_updated_at, first_name, last_name)
           VALUES (fold_current_tenant(), '11111111-1111-4111-8111-111111111111', now(), $1, 'Person')`,
          [`only-${t.slug}`],
        );
        await c.query(
          `INSERT INTO outbox (tenant_id, kind, idempotency_key, payload) VALUES (fold_current_tenant(), 'k', 'same-key', '{}')`,
        );
        await c.query(
          `INSERT INTO audit_log (tenant_id, action, subject_type) VALUES (fold_current_tenant(), 'A', 'S')`,
        );
      });
    }
    postB = await withTenant(db.appPool, b.id, async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO post (tenant_id, author_person_id, audience, body) VALUES (fold_current_tenant(), gen_random_uuid(), 'CHURCH', 'hello B') RETURNING id`,
      );
      return (r.rows[0] as { id: string }).id;
    });
  });
  afterAll(async () => {
    await db.drop();
  });

  it('with no tenant context, the app role sees nothing in any tenant table', async () => {
    for (const table of ['person_read', 'outbox', 'audit_log', 'post']) {
      const r = await db.appPool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
      expect(r.rows[0]?.n, table).toBe('0');
    }
  });

  it('inside a tenant, only that tenant’s rows are visible', async () => {
    for (const [t, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const rows = await withTenant(db.appPool, t.id, async (c) => {
        const p = await c.query<{ first_name: string }>('SELECT first_name FROM person_read');
        const o = await c.query('SELECT 1 FROM outbox');
        const au = await c.query('SELECT 1 FROM audit_log');
        return { people: p.rows.map((r) => r.first_name), outbox: o.rowCount, audit: au.rowCount };
      });
      expect(rows.people).toEqual([`only-${t.slug}`]);
      expect(rows.people).not.toContain(`only-${other.slug}`);
      expect(rows.outbox).toBe(1);
      expect(rows.audit).toBe(1);
    }
  });

  it('cannot insert a row for another tenant (WITH CHECK)', async () => {
    await expect(
      withTenant(db.appPool, a.id, (c) =>
        c.query(
          `INSERT INTO person_read (tenant_id, twenty_person_id, twenty_updated_at) VALUES ($1, gen_random_uuid(), now())`,
          [b.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('cannot update or delete another tenant’s rows, and cannot move a row to another tenant', async () => {
    const upd = await withTenant(db.appPool, a.id, (c) =>
      c.query(
        `UPDATE person_read SET first_name = 'hacked' WHERE twenty_person_id = '11111111-1111-4111-8111-111111111111'`,
      ),
    );
    expect(upd.rowCount).toBe(1); // A's own row only
    const bName = await withTenant(db.appPool, b.id, (c) =>
      c.query<{ first_name: string }>('SELECT first_name FROM person_read'),
    );
    expect(bName.rows).toEqual([{ first_name: 'only-church-b' }]);

    const del = await withTenant(db.appPool, a.id, (c) => c.query(`DELETE FROM outbox`));
    expect(del.rowCount).toBe(1);
    const bOutbox = await withTenant(db.appPool, b.id, (c) => c.query('SELECT 1 FROM outbox'));
    expect(bOutbox.rowCount).toBe(1);

    await expect(
      withTenant(db.appPool, a.id, (c) => c.query(`UPDATE person_read SET tenant_id = $1`, [b.id])),
    ).rejects.toThrow(/row-level security/);
  });

  it('the same idempotency key can exist in two tenants without collision or leakage', async () => {
    await withTenant(db.appPool, a.id, (c) =>
      c.query(
        `INSERT INTO outbox (tenant_id, kind, idempotency_key, payload) VALUES (fold_current_tenant(), 'k', 'same-key', '{}')`,
      ),
    );
    const n = await withTenant(db.appPool, a.id, (c) =>
      c.query(`SELECT 1 FROM outbox WHERE idempotency_key = 'same-key'`),
    );
    expect(n.rowCount).toBe(1);
  });

  it('a composite foreign key stops a row in one tenant pointing at another tenant’s row', async () => {
    await expect(
      withTenant(db.appPool, a.id, (c) =>
        c.query(
          `INSERT INTO comment (tenant_id, post_id, author_person_id, body) VALUES (fold_current_tenant(), $1, gen_random_uuid(), 'sneaky')`,
          [postB],
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('the tenant context never leaks to the next user of a pooled connection', async () => {
    const single = new Pool({ connectionString: db.appUrl, max: 1 });
    try {
      const inside = await withTenant(single, a.id, (c) => c.query('SELECT 1 FROM person_read'));
      expect(inside.rowCount).toBe(1);
      // Same physical connection (max: 1). The setting was transaction-local, so it is gone.
      const after = await single.query('SELECT 1 FROM person_read');
      expect(after.rowCount).toBe(0);
      const setting = await single.query<{ v: string | null }>(
        `SELECT current_setting('app.tenant_id', true) AS v`,
      );
      expect(setting.rows[0]?.v ?? '').toBe('');
    } finally {
      await single.end();
    }
  });

  it('rolls back and still clears the context when the work fails', async () => {
    const single = new Pool({ connectionString: db.appUrl, max: 1 });
    try {
      await expect(
        withTenant(single, a.id, async (c) => {
          await c.query(
            `INSERT INTO audit_log (tenant_id, action, subject_type) VALUES (fold_current_tenant(), 'ROLLED_BACK', 'S')`,
          );
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      const rows = await withTenant(single, a.id, (c) =>
        c.query(`SELECT 1 FROM audit_log WHERE action = 'ROLLED_BACK'`),
      );
      expect(rows.rowCount).toBe(0);
    } finally {
      await single.end();
    }
  });

  it('refuses a non-UUID tenant id before it reaches SQL', async () => {
    await expect(
      withTenant(db.appPool, `${a.id}'; DROP TABLE person_read; --`, () => Promise.resolve(1)),
    ).rejects.toThrow(TypeError);
    await expect(withTenant(db.appPool, '', () => Promise.resolve(1))).rejects.toThrow(TypeError);
  });

  it('fails closed on a malformed tenant setting', async () => {
    const c = await db.appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.tenant_id', 'not-a-uuid', true)`);
      await expect(c.query('SELECT 1 FROM person_read')).rejects.toThrow(
        /invalid input syntax for type uuid/,
      );
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  describe('the tenant table and lookups', () => {
    it('a tenant sees only its own tenant row; the app can never write tenants', async () => {
      const own = await withTenant(db.appPool, a.id, (c) =>
        c.query<{ slug: string }>('SELECT slug FROM tenant'),
      );
      expect(own.rows).toEqual([{ slug: 'church-a' }]);
      const none = await db.appPool.query('SELECT 1 FROM tenant');
      expect(none.rowCount).toBe(0);
      await expect(
        withTenant(db.appPool, a.id, (c) => c.query(`UPDATE tenant SET name = 'x'`)),
      ).rejects.toThrow(/permission denied/);
      await expect(
        withTenant(db.appPool, a.id, (c) =>
          c.query(
            `INSERT INTO tenant (slug, subdomain, name, twenty_base_url) VALUES ('evil', 'evil', 'x', 'https://x')`,
          ),
        ),
      ).rejects.toThrow(/permission denied/);
    });

    it('lists only ACTIVE tenants for workers, without needing a tenant context', async () => {
      const ids = await listActiveTenantIds(db.appPool);
      expect(ids.sort()).toEqual([a.id, b.id].sort());
    });

    it('resolves subdomains case-insensitively, and not for suspended or unknown tenants', async () => {
      expect(await tenantIdForSubdomain(db.appPool, 'CHURCH-A')).toBe(a.id);
      expect(await tenantIdForSubdomain(db.appPool, 'church-c')).toBeNull();
      expect(await tenantIdForSubdomain(db.appPool, 'nope')).toBeNull();
    });
  });
});
