// SPDX-License-Identifier: AGPL-3.0-or-later
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, MIGRATIONS_DIR } from '../src/db/migrate.js';
import { createTestDatabase, dbAvailable, type TestDb } from './helpers/db.js';

describe.skipIf(!dbAvailable)('migration runner', () => {
  let db: TestDb;
  let dir: string;
  beforeEach(async () => {
    db = await createTestDatabase({ migrate: false });
    dir = mkdtempSync(join(tmpdir(), 'fold-mig-'));
  });
  afterEach(async () => {
    await db.drop();
    rmSync(dir, { recursive: true, force: true });
  });

  const client = async () => {
    const c = new Client({ connectionString: db.ownerUrl });
    await c.connect();
    return c;
  };

  it('applies every migration once, in order, and is a no-op the second time', async () => {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const c = await client();
    try {
      const first = await migrate(c);
      expect(first.applied).toEqual(files);
      const second = await migrate(c);
      expect(second.applied).toEqual([]);
      expect(second.alreadyApplied).toEqual(files);
    } finally {
      await c.end();
    }
  });

  it('refuses to run if an applied migration was edited', async () => {
    writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a (id int);');
    const c = await client();
    try {
      await migrate(c, dir);
      writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a (id int, sneaky text);');
      await expect(migrate(c, dir)).rejects.toThrow(/edited after it was applied/);
    } finally {
      await c.end();
    }
  });

  it('rolls a failing migration back completely, keeping earlier ones', async () => {
    writeFileSync(join(dir, '0001_ok.sql'), 'CREATE TABLE ok (id int);');
    writeFileSync(join(dir, '0002_bad.sql'), 'CREATE TABLE half (id int); SELECT 1/0;');
    const c = await client();
    try {
      await expect(migrate(c, dir)).rejects.toThrow(/0002_bad.sql failed/);
      const tables = await c.query<{ t: string }>(
        `SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`,
      );
      expect(tables.rows.map((r) => r.t)).toEqual(['ok', 'schema_migrations']);
      const done = await c.query<{ version: string }>('SELECT version FROM schema_migrations');
      expect(done.rows).toEqual([{ version: '0001_ok.sql' }]);
    } finally {
      await c.end();
    }
  });

  it('ignores files that are not numbered migrations', async () => {
    writeFileSync(join(dir, '0001_a.sql'), 'CREATE TABLE a (id int);');
    writeFileSync(join(dir, 'notes.sql'), 'DROP DATABASE oops;');
    writeFileSync(join(dir, 'README.md'), '# hi');
    const c = await client();
    try {
      expect((await migrate(c, dir)).applied).toEqual(['0001_a.sql']);
    } finally {
      await c.end();
    }
  });

  it('two runners started at once apply each migration exactly once', async () => {
    for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith('.sql')))
      copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
    const [c1, c2] = await Promise.all([client(), client()]);
    try {
      const [r1, r2] = await Promise.all([migrate(c1, dir), migrate(c2, dir)]);
      expect([...r1.applied, ...r2.applied].sort()).toEqual(readdirSync(dir).sort());
    } finally {
      await Promise.all([c1.end(), c2.end()]);
    }
  });
});
