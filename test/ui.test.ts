import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BookOrbit } from '../src/bookorbit.js';
import { connect, type Db, migrate } from '../src/db.js';
import { createLogger } from '../src/log.js';
import { createUi } from '../src/ui.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://bookorbit:bookorbit@localhost:55432/crossorbit_test';
const SQLITE = DATABASE_URL.startsWith('sqlite:');
const API_KEY = 'bok_secret_ui';
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

let db: Db;
let server: Server;
let ui: ReturnType<typeof createUi>;
const seen: { path: string; key: string | undefined }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const key = req.headers['x-api-key'] as string | undefined;
    seen.push({ path: req.url ?? '', key });
    if (key !== API_KEY) return res.writeHead(401).end();
    if (req.url === '/api/v1/auth/me') return res.writeHead(200).end('{}');
    if (req.url === '/api/v1/books/1') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 1, title: 'Dune <b>', authors: [{ name: 'Frank Herbert' }] }));
    if (req.url === '/api/v1/books/1/thumbnail') return res.writeHead(200, { 'content-type': 'image/jpeg' }).end(PNG);
    if (req.url === '/api/v1/books/2') return res.writeHead(500).end();
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  db = connect(SQLITE ? `sqlite:${join(mkdtempSync(join(tmpdir(), 'crossorbit-ui-')), 'test.db')}` : DATABASE_URL);
  if (!SQLITE) {
    await sql`DROP SCHEMA public CASCADE`.execute(db);
    await sql`CREATE SCHEMA public`.execute(db);
  }
  await migrate(db);
  await db.insertInto('documents').values([
    { document: 'aaaa', book_id: 1, book_file_id: 11 },
    { document: 'bbbb', book_id: 2, book_file_id: 22 },
  ]).execute();
  await db.insertInto('positions').values({ username: 'reader', document: 'aaaa', progress: 'x', percentage: 0.42, position: { a: 1 } }).execute();
  const base = { book_file_id: 11, book_id: 1, chapter: 'One', created_at: 1700000000, deleted: false, text: '' };
  await db.insertInto('clippings').values([
    { ...base, clipping_id: 'c1', annotation_id: 100, revision: 1, text: '<script>alert(1)</script>' },
    { ...base, clipping_id: 'c2', annotation_id: 101, revision: 2, deleted: true },
    { ...base, clipping_id: 'bookorbit-102', annotation_id: 102, revision: 3, deleted: true },
    { ...base, clipping_id: 'c3', annotation_id: null, revision: 4, text: 'loose' },
  ]).execute();
  ui = createUi(db, new BookOrbit(url, API_KEY), createLogger('error'));
});

afterAll(async () => {
  await db.destroy();
  await new Promise((resolve) => server.close(resolve));
});

const get = async (path: string) => {
  const res = await ui.request(path);
  return { status: res.status, type: res.headers.get('content-type'), text: await res.text() };
};

describe('ui', () => {
  it('renders the shelf with metadata, progress and counts', async () => {
    const { status, text } = await get('/');
    expect(status).toBe(200);
    expect(text).toMatch(/^<!doctype html>/);
    expect(text).toContain('Dune &lt;b&gt;');
    expect(text).toContain('Frank Herbert');
    expect(text).toContain('42.0%');
    expect(text).toContain('1 synced');
    expect(text).toContain('2 unanchored');
    expect(text).toContain('1 deleted');
    expect(text).toContain('Database up');
    expect(text).toContain('BookOrbit up');
    expect(text).not.toContain(API_KEY);
  });

  it('renders book detail with escaped highlights', async () => {
    const { status, text } = await get('/books/11');
    expect(status).toBe(200);
    expect(text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(text).not.toContain('<script>alert');
    expect(text).toContain('rev 4');
    expect((await get('/books/999')).status).toBe(404);
  });

  it('renders activity and problems', async () => {
    const activity = await get('/activity');
    expect(activity.status).toBe(200);
    expect(activity.text.indexOf('rev 4')).toBeLessThan(activity.text.indexOf('rev 1'));
    expect(activity.text).toContain('reader');
    const problems = await get('/problems');
    expect(problems.status).toBe(200);
    expect(problems.text).toContain('bookorbit-102');
    expect(problems.text).toContain('loose');
    expect(problems.text).toContain('request failed');
    expect(problems.text).not.toContain('&lt;script&gt;');
  });

  it('proxies covers without exposing the key', async () => {
    const res = await ui.request('/covers/1');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
    for (const [, value] of res.headers) expect(value).not.toContain(API_KEY);
    expect(seen.find((r) => r.path === '/api/v1/books/1/thumbnail')?.key).toBe(API_KEY);
    expect((await ui.request('/covers/3')).status).toBe(404);
  });

  it('rejects non-GET methods', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const path of ['/', '/books/11', '/covers/1', '/activity']) {
        expect([404, 405]).toContain((await ui.request(path, { method })).status);
      }
    }
  });
});
