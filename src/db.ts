import SqliteDatabase from 'better-sqlite3';
import {
  type Generated, Kysely, type KyselyPlugin, OperationNodeTransformer, PostgresDialect, type PrimitiveValueListNode, type RawBuilder,
  sql, SqliteAdapter, SqliteDialect, type ValueNode,
} from 'kysely';
import { type Migration, Migrator } from 'kysely/migration';
import pg from 'pg';

export interface Schema {
  documents: { document: string; book_id: number; book_file_id: number; resolved_at: Generated<Date | string> };
  clippings: {
    book_file_id: number;
    clipping_id: string;
    book_id: number;
    annotation_id: number | null;
    revision: string | number;
    deleted: Generated<boolean | number>;
    spine: Generated<number>;
    start_page: Generated<number>;
    end_page: Generated<number>;
    pages: Generated<number>;
    start_word: Generated<number>;
    end_word: Generated<number>;
    words: Generated<number>;
    para: number | null;
    chapter: Generated<string>;
    text: Generated<string>;
    created_at: Generated<string | number>;
    layout_signature: Generated<string | number>;
    start_offset: string | number | null;
    end_offset: string | number | null;
    ko_datetime: string | null;
    ko_key: string | null;
    pos0: string | null;
    pos1: string | null;
    note: string | null;
    color: string | null;
    ko_dirty: Generated<boolean | number>;
  };
  positions: {
    username: string;
    document: string;
    progress: string;
    percentage: number;
    position: unknown;
    updated_at: Generated<Date | string>;
  };
  revision_counter: { id: number; value: string | number };
  bookmarks: {
    book_file_id: number;
    bookmark_id: string;
    book_id: number;
    bookorbit_id: number | null;
    revision: string | number;
    deleted: Generated<boolean | number>;
    xpath: Generated<string>;
    percentage: Generated<number>;
    summary: Generated<string>;
    si: Generated<number>;
    pc: Generated<number>;
    pp: Generated<number>;
    name: Generated<string>;
    vo: string | number | null;
    title: Generated<string>;
    ko_datetime: string | null;
    ko_key: string | null;
    ko_dirty: Generated<boolean | number>;
  };
  reading_sessions: {
    session_id: string;
    device_id: string;
    username: string;
    document: string;
    started_at: string | number;
    ended_at: string | number;
    seconds: number;
    utc_offset_minutes: number;
    book_file_id: number | null;
    status: string;
    attempts: Generated<number>;
    last_error: string | null;
    created_at: Generated<Date | string>;
    uploaded_at: Date | string | null;
  };
  pending_items: {
    username: string;
    document: string;
    kind: string;
    item_id: string;
    payload: unknown;
    updated_at: Generated<Date | string>;
  };
  pending_progress: {
    username: string;
    document: string;
    body: unknown;
    timestamp: string | number;
    updated_at: Generated<Date | string>;
  };
  document_hints: {
    username: string;
    document: string;
    title: string | null;
    authors: string | null;
    updated_at: Generated<Date | string>;
  };
  exchange_problems: {
    username: string;
    document: string;
    kind: string;
    problem: string;
    updated_at: Generated<Date | string>;
  };
}

export type Db = Kysely<Schema>;

const toSqlite = (v: unknown) =>
  typeof v === 'boolean' ? Number(v) : v !== null && typeof v === 'object' && !(v instanceof Uint8Array) ? JSON.stringify(v) : v;

class SqliteValues extends OperationNodeTransformer {
  protected override transformValue(node: ValueNode): ValueNode {
    return { ...node, value: toSqlite(node.value) };
  }
  protected override transformPrimitiveValueList(node: PrimitiveValueListNode): PrimitiveValueListNode {
    return { ...node, values: node.values.map(toSqlite) };
  }
}

const sqliteValues: KyselyPlugin = {
  transformQuery: ({ node }) => new SqliteValues().transformNode(node),
  transformResult: async ({ result }) => result,
};

export function connect(url: string, onPoolError: (error: Error) => void = () => {}): Db {
  if (url.startsWith('sqlite:')) {
    const database = new SqliteDatabase(url.slice('sqlite:'.length));
    database.pragma('journal_mode = WAL');
    database.pragma('foreign_keys = ON');
    database.pragma('busy_timeout = 5000');
    return new Kysely<Schema>({ dialect: new SqliteDialect({ database }), plugins: [sqliteValues] });
  }
  if (/^postgres(ql)?:\/\//.test(url)) {
    const pool = new pg.Pool({ connectionString: url, max: 3 });
    pool.on('error', onPoolError);
    return new Kysely<Schema>({ dialect: new PostgresDialect({ pool }) });
  }
  throw new Error('DATABASE_URL must start with postgres://, postgresql:// or sqlite:');
}

export const isSqlite = (db: Kysely<any>) => db.getExecutor().adapter instanceof SqliteAdapter;

export const now = (db: Kysely<any>): RawBuilder<string> =>
  isSqlite(db) ? sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))` : sql`now()`;

export async function nextRevision(db: Db): Promise<number> {
  const { value } = await db.updateTable('revision_counter').set({ value: sql`value + 1` }).where('id', '=', 1)
    .returning('value').executeTakeFirstOrThrow();
  return Number(value);
}

const migrations: Record<string, Migration> = {
  '001_init': {
    async up(db) {
      const pg = !isSqlite(db);
      const ts = pg ? 'timestamptz' : 'text';
      await db.schema.createTable('documents')
        .addColumn('document', 'text', (c) => c.primaryKey())
        .addColumn('book_id', 'integer', (c) => c.notNull())
        .addColumn('book_file_id', 'integer', (c) => c.notNull())
        .addColumn('resolved_at', ts, (c) => c.notNull().defaultTo(now(db)))
        .execute();
      await db.schema.createTable('clippings')
        .addColumn('book_file_id', 'integer', (c) => c.notNull())
        .addColumn('clipping_id', 'text', (c) => c.notNull())
        .addColumn('book_id', 'integer', (c) => c.notNull())
        .addColumn('annotation_id', 'integer')
        .addColumn('revision', 'bigint', (c) => c.notNull())
        .addColumn('deleted', 'boolean', (c) => c.notNull().defaultTo(false))
        .$call((t) => ['spine', 'start_page', 'end_page'].reduce((t, n) => t.addColumn(n, 'integer', (c) => c.notNull().defaultTo(0)), t))
        .addColumn('pages', 'integer', (c) => c.notNull().defaultTo(1))
        .$call((t) => ['start_word', 'end_word', 'words'].reduce((t, n) => t.addColumn(n, 'integer', (c) => c.notNull().defaultTo(0)), t))
        .addColumn('para', 'integer')
        .addColumn('chapter', 'text', (c) => c.notNull().defaultTo(''))
        .addColumn('text', 'text', (c) => c.notNull().defaultTo(''))
        .addColumn('created_at', 'bigint', (c) => c.notNull().defaultTo(0))
        .addColumn('layout_signature', 'bigint', (c) => c.notNull().defaultTo(0))
        .addColumn('start_offset', 'bigint')
        .addColumn('end_offset', 'bigint')
        .addPrimaryKeyConstraint('clippings_pkey', ['book_file_id', 'clipping_id'])
        .execute();
      await db.schema.createIndex('clippings_revision').on('clippings').columns(['book_file_id', 'revision']).execute();
      await db.schema.createIndex('clippings_annotation').on('clippings').columns(['book_file_id', 'annotation_id']).unique()
        .where(sql.ref('annotation_id'), 'is not', null).execute();
    },
  },
  '002_positions': {
    async up(db) {
      const pg = !isSqlite(db);
      await db.schema.createTable('positions')
        .addColumn('username', 'text', (c) => c.notNull())
        .addColumn('document', 'text', (c) => c.notNull())
        .addColumn('progress', 'text', (c) => c.notNull())
        .addColumn('percentage', 'double precision', (c) => c.notNull())
        .addColumn('position', pg ? 'jsonb' : 'text', (c) => c.notNull())
        .addColumn('updated_at', pg ? 'timestamptz' : 'text', (c) => c.notNull().defaultTo(now(db)))
        .addPrimaryKeyConstraint('positions_pkey', ['username', 'document'])
        .execute();
    },
  },
  '003_revision_counter': {
    async up(db) {
      const pg = !isSqlite(db);
      if (pg) await sql`LOCK TABLE clippings IN EXCLUSIVE MODE`.execute(db);
      await db.schema.createTable('revision_counter')
        .addColumn('id', 'integer', (c) => c.primaryKey())
        .addColumn('value', 'bigint', (c) => c.notNull())
        .execute();
      const max = sql<number>`(SELECT coalesce(max(revision), 0) FROM clippings)`;
      const seq = sql<number>`(SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM clipping_revision)`;
      const legacy = pg && (await sql`SELECT to_regclass('clipping_revision') AS t`.execute(db)).rows.some((r: any) => r.t);
      await db.insertInto('revision_counter').values({ id: 1, value: legacy ? sql`greatest(${seq}, ${max})` : max }).execute();
      if (legacy) {
        await sql`ALTER TABLE clippings ALTER COLUMN revision DROP DEFAULT`.execute(db);
        await sql`DROP SEQUENCE clipping_revision`.execute(db);
      }
    },
  },
  '004_bookmarks_sessions': {
    async up(db) {
      const ts = isSqlite(db) ? 'text' : 'timestamptz';
      await db.schema.createTable('bookmarks')
        .addColumn('book_file_id', 'integer', (c) => c.notNull())
        .addColumn('bookmark_id', 'text', (c) => c.notNull())
        .addColumn('book_id', 'integer', (c) => c.notNull())
        .addColumn('bookorbit_id', 'integer')
        .addColumn('revision', 'bigint', (c) => c.notNull())
        .addColumn('deleted', 'boolean', (c) => c.notNull().defaultTo(false))
        .addColumn('xpath', 'text', (c) => c.notNull().defaultTo(''))
        .addColumn('percentage', 'double precision', (c) => c.notNull().defaultTo(0))
        .addColumn('summary', 'text', (c) => c.notNull().defaultTo(''))
        .$call((t) => ['si', 'pc', 'pp'].reduce((t, n) => t.addColumn(n, 'integer', (c) => c.notNull().defaultTo(0)), t))
        .addColumn('name', 'text', (c) => c.notNull().defaultTo(''))
        .addColumn('vo', 'bigint')
        .addColumn('title', 'text', (c) => c.notNull().defaultTo(''))
        .addPrimaryKeyConstraint('bookmarks_pkey', ['book_file_id', 'bookmark_id'])
        .execute();
      await db.schema.createIndex('bookmarks_revision').on('bookmarks').columns(['book_file_id', 'revision']).execute();
      await db.schema.createIndex('bookmarks_bookorbit').on('bookmarks').columns(['book_file_id', 'bookorbit_id']).unique()
        .where(sql.ref('bookorbit_id'), 'is not', null).execute();
      await db.schema.createTable('reading_sessions')
        .addColumn('session_id', 'text', (c) => c.notNull())
        .addColumn('device_id', 'text', (c) => c.notNull())
        .addColumn('username', 'text', (c) => c.notNull())
        .addColumn('document', 'text', (c) => c.notNull())
        .addColumn('started_at', 'bigint', (c) => c.notNull())
        .addColumn('ended_at', 'bigint', (c) => c.notNull())
        .addColumn('seconds', 'integer', (c) => c.notNull())
        .addColumn('utc_offset_minutes', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('book_file_id', 'integer')
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('last_error', 'text')
        .addColumn('created_at', ts, (c) => c.notNull().defaultTo(now(db)))
        .addColumn('uploaded_at', ts)
        .addPrimaryKeyConstraint('reading_sessions_pkey', ['username', 'session_id'])
        .execute();
      await db.schema.createIndex('reading_sessions_status').on('reading_sessions').columns(['username', 'status']).execute();
    },
  },
  '005_pending': {
    async up(db) {
      const pg = !isSqlite(db);
      const ts = pg ? 'timestamptz' : 'text';
      const json = pg ? 'jsonb' : 'text';
      await db.schema.createTable('pending_items')
        .addColumn('username', 'text', (c) => c.notNull())
        .addColumn('document', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('item_id', 'text', (c) => c.notNull())
        .addColumn('payload', json, (c) => c.notNull())
        .addColumn('updated_at', ts, (c) => c.notNull().defaultTo(now(db)))
        .addPrimaryKeyConstraint('pending_items_pkey', ['username', 'document', 'kind', 'item_id'])
        .execute();
      await db.schema.createTable('pending_progress')
        .addColumn('username', 'text', (c) => c.notNull())
        .addColumn('document', 'text', (c) => c.notNull())
        .addColumn('body', json, (c) => c.notNull())
        .addColumn('timestamp', 'bigint', (c) => c.notNull())
        .addColumn('updated_at', ts, (c) => c.notNull().defaultTo(now(db)))
        .addPrimaryKeyConstraint('pending_progress_pkey', ['username', 'document'])
        .execute();
      await db.schema.createTable('document_hints')
        .addColumn('username', 'text', (c) => c.notNull())
        .addColumn('document', 'text', (c) => c.notNull())
        .addColumn('title', 'text')
        .addColumn('authors', 'text')
        .addColumn('updated_at', ts, (c) => c.notNull().defaultTo(now(db)))
        .addPrimaryKeyConstraint('document_hints_pkey', ['username', 'document'])
        .execute();
    },
  },
  '006_koreader_exchange': {
    async up(db) {
      const ts = isSqlite(db) ? 'text' : 'timestamptz';
      // Existing rows already reached BookOrbit through the REST API, so they start clean; the first
      // exchange then reports them in its key list and BookOrbit links them by datetime.
      for (const table of ['clippings', 'bookmarks'] as const) {
        const columns = table === 'clippings' ? ['ko_datetime', 'ko_key', 'pos0', 'pos1', 'note', 'color'] : ['ko_datetime', 'ko_key'];
        for (const column of columns) await db.schema.alterTable(table).addColumn(column, 'text').execute();
        await db.schema.alterTable(table).addColumn('ko_dirty', 'boolean', (c) => c.notNull().defaultTo(false)).execute();
      }
      await db.schema.createIndex('clippings_ko_key').on('clippings').columns(['book_file_id', 'ko_key']).execute();
      await db.schema.createIndex('bookmarks_ko_key').on('bookmarks').columns(['book_file_id', 'ko_key']).execute();
      await db.schema.createTable('exchange_problems')
        .addColumn('username', 'text', (c) => c.notNull())
        .addColumn('document', 'text', (c) => c.notNull())
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('problem', 'text', (c) => c.notNull())
        .addColumn('updated_at', ts, (c) => c.notNull().defaultTo(now(db)))
        .addPrimaryKeyConstraint('exchange_problems_pkey', ['username', 'document', 'kind'])
        .execute();
    },
  },
};

async function adoptLegacy(db: Kysely<any>) {
  if (isSqlite(db)) return;
  const { rows } = await sql<{ t: string | null }>`SELECT to_regclass('schema_migrations')::text AS t`.execute(db);
  if (!rows[0]?.t) return;
  await sql`CREATE TABLE IF NOT EXISTS kysely_migration (name varchar(255) NOT NULL PRIMARY KEY, timestamp varchar(255) NOT NULL)`.execute(db);
  await sql`
    INSERT INTO kysely_migration (name, timestamp)
    SELECT replace(name, '.sql', ''), to_char(applied_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    FROM schema_migrations WHERE name IN ('001_init.sql', '002_positions.sql')
    ON CONFLICT (name) DO NOTHING`.execute(db);
}

export async function migrate(db: Db): Promise<void> {
  await adoptLegacy(db);
  const { error } = await new Migrator({ db, provider: { getMigrations: async () => migrations } }).migrateToLatest();
  if (error) throw error;
}
