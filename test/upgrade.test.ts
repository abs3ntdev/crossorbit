import { readFileSync } from 'node:fs';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connect, type Db, migrate, nextRevision } from '../src/db.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://bookorbit:bookorbit@localhost:55432/crossorbit_test';
const DATABASE = 'crossorbit_upgrade_test';
const legacy = (name: string) => readFileSync(new URL(`fixtures/legacy/${name}`, import.meta.url), 'utf8');

describe.skipIf(DATABASE_URL.startsWith('sqlite:'))('upgrade from the legacy Postgres runner', () => {
  let db: Db;

  beforeAll(async () => {
    const admin = connect(DATABASE_URL);
    await sql`DROP DATABASE IF EXISTS ${sql.id(DATABASE)} WITH (FORCE)`.execute(admin);
    await sql`CREATE DATABASE ${sql.id(DATABASE)}`.execute(admin);
    await admin.destroy();
    const url = new URL(DATABASE_URL);
    url.pathname = `/${DATABASE}`;
    db = connect(url.toString());
    await sql`CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`.execute(db);
    for (const name of ['001_init.sql', '002_positions.sql']) {
      await sql.raw(legacy(name)).execute(db);
      await sql`INSERT INTO schema_migrations (name) VALUES (${name})`.execute(db);
    }
    await sql`INSERT INTO clippings (book_file_id, clipping_id, book_id) VALUES (1, 'a', 1), (1, 'b', 1)`.execute(db);
    await sql`SELECT nextval('clipping_revision') FROM generate_series(1, 5)`.execute(db);
    await sql`INSERT INTO positions (username, document, progress, percentage, position) VALUES ('u', 'd', '', 0.5, '{"page":3}')`.execute(db);
  });

  afterAll(async () => {
    await db?.destroy();
  });

  it('adopts applied migrations, keeps data, and continues revisions past the sequence', async () => {
    await migrate(db);
    await migrate(db);
    const names = await db.selectFrom('kysely_migration' as never).select('name' as never).orderBy('name' as never).execute();
    expect(names.map((r) => (r as { name: string }).name)).toEqual(['001_init', '002_positions', '003_revision_counter']);
    const rows = await db.selectFrom('clippings').select(['clipping_id', 'revision']).orderBy('revision').execute();
    expect(rows.map((r) => [r.clipping_id, Number(r.revision)])).toEqual([['a', 1], ['b', 2]]);
    expect(await db.selectFrom('positions').select('position').executeTakeFirst()).toEqual({ position: { page: 3 } });
    const { rows: seq } = await sql<{ t: string | null }>`SELECT to_regclass('clipping_revision')::text AS t`.execute(db);
    expect(seq[0].t).toBeNull();
    expect(await db.transaction().execute(nextRevision)).toBe(8);
  });
});
