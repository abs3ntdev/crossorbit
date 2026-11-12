import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

export type Sql = postgres.Sql;

const MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url));

export function connect(url: string): Sql {
  return postgres(url, { onnotice: () => {}, max: 10 });
}

export async function migrate(sql: Sql): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort();
  for (const name of files) {
    const body = await readFile(MIGRATIONS + name, 'utf8');
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(7413)`;
      const [done] = await tx`SELECT 1 FROM schema_migrations WHERE name = ${name}`;
      if (done) return;
      await tx.unsafe(body);
      await tx`INSERT INTO schema_migrations (name) VALUES (${name})`;
    });
  }
}
