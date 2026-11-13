import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import { connect } from '../src/db.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://bookorbit:bookorbit@localhost:55432/crossorbit_test';

describe.skipIf(DATABASE_URL.startsWith('sqlite:'))('postgres pool', () => {
  it('survives an idle connection being terminated by the server', async () => {
    const errors: Error[] = [];
    const db = connect(DATABASE_URL, (error) => errors.push(error));
    const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(db);
    const admin = connect(DATABASE_URL);
    await sql`SELECT pg_terminate_backend(${rows[0].pid})`.execute(admin);
    await admin.destroy();
    await expect.poll(() => errors.length).toBe(1);
    await expect(sql`SELECT 1`.execute(db)).resolves.toBeDefined();
    await db.destroy();
  });
});
