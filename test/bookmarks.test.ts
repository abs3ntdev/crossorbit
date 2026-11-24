import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { BookOrbit } from '../src/bookorbit.js';
import { bookmarkIdFor } from '../src/bookmarks.js';
import { connect, type Db, migrate } from '../src/db.js';
import { EpubBook } from '../src/epub/book.js';
import { cfiToXPointer, xpointerToCfi } from '../src/epub/xpointer.js';
import { createLogger } from '../src/log.js';
import { registry } from '../src/metrics.js';
import { fixtureEpub } from './fixture.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://bookorbit:bookorbit@localhost:55432/crossorbit_test';
const SQLITE = DATABASE_URL.startsWith('sqlite:');
const HASH = '0123456789abcdef0123456789abcdef';
const LATE = 'fedcba9876543210fedcba9876543210';
const AUTH = { 'x-auth-user': 'reader', 'x-auth-key': '5f4dcc3b5aa765d61d8327deb882cf99' };
const API_KEY = 'bok_test';

interface FakeBookmark { id: number; bookId: number; cfi: string | null; title: string; bookFileId?: number }

class FakeBookOrbit {
  bookmarks: FakeBookmark[] = [];
  sessions: Record<string, unknown>[] = [];
  lateKnown = false;
  failSessions = false;
  nextId = 500;
  server!: Server;
  url = '';

  async start() {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      const path = req.url ?? '';
      const json = (status: number, value?: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(value === undefined ? '' : JSON.stringify(value));
      };
      if (path.startsWith('/api/v1/koreader/')) {
        if (req.headers['x-auth-user'] !== AUTH['x-auth-user'] || req.headers['x-auth-key'] !== AUTH['x-auth-key']) return json(401);
        if (path === '/api/v1/koreader/users/auth') return json(200, { authorized: 'OK' });
        if (path === '/api/v1/koreader/plugin/match-check') {
          const matches = [];
          if (body.hashes.includes(HASH)) matches.push({ hash: HASH, bookId: 1, bookFileId: 11 });
          if (this.lateKnown && body.hashes.includes(LATE)) matches.push({ hash: LATE, bookId: 2, bookFileId: 22 });
          return json(201, { matches });
        }
      }
      if (req.headers['x-api-key'] !== API_KEY) return json(401);
      if (path === '/api/v1/books/files/11/serve') {
        res.writeHead(200, { 'content-type': 'application/epub+zip' });
        return res.end(Buffer.from(fixtureEpub()));
      }
      const s = /^\/api\/v1\/books\/files\/(\d+)\/sessions$/.exec(path);
      if (s && req.method === 'POST') {
        if (this.failSessions) return json(500);
        if (!this.sessions.some((x) => x.sessionId === body.sessionId)) this.sessions.push({ fileId: Number(s[1]), ...body });
        return json(204);
      }
      const m = /^\/api\/v1\/books\/1\/bookmarks(?:\/(\d+))?(?:\?.*)?$/.exec(path);
      if (m && !m[1] && req.method === 'GET') return json(200, this.bookmarks);
      if (m && !m[1] && req.method === 'POST') {
        const b = { id: this.nextId++, bookId: 1, cfi: body.cfi, title: body.title, bookFileId: body.bookFileId };
        this.bookmarks.push(b);
        return json(201, b);
      }
      const existing = m?.[1] ? this.bookmarks.find((b) => b.id === Number(m[1])) : undefined;
      if (m?.[1] && !existing) return json(404);
      if (existing && req.method === 'PATCH') {
        existing.title = body.title;
        return json(200, existing);
      }
      if (existing && req.method === 'DELETE') {
        this.bookmarks = this.bookmarks.filter((b) => b !== existing);
        return json(204);
      }
      json(404);
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
}

let db: Db;
const fake = new FakeBookOrbit();
let app: ReturnType<typeof createApp>;

const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = AUTH) => {
  const res = await app.request(path, {
    method,
    headers: { ...headers, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const mark = (xpath: string, extra: Record<string, unknown> = {}) => ({
  id: bookmarkIdFor(xpath), deleted: 0, xpath, percentage: 0.25, summary: 'Hello brave new world.', si: 0, pc: 3, pp: 1, name: '', ...extra,
});

/** Pulls like the device does, enforcing its paging rules. */
async function pullAll(limit = 1) {
  const items: Record<string, unknown>[] = [];
  let cursor = 0;
  for (;;) {
    const { status, body } = await call('GET', `/api/v1/bookmarks/${HASH}?cursor=${cursor}&limit=${limit}`);
    expect(status).toBe(200);
    expect(body.sync_version).toBe(2);
    expect(body.items.length).toBeLessThanOrEqual(limit);
    expect(body.cursor).toBeGreaterThanOrEqual(cursor);
    if (body.more) expect(body.items.length).toBeGreaterThan(0);
    items.push(...body.items);
    cursor = body.cursor;
    if (!body.more) return items;
  }
}

const latest = (items: Record<string, unknown>[]) => new Map(items.map((i) => [i.id, i]));

beforeAll(async () => {
  db = connect(SQLITE ? `sqlite:${join(mkdtempSync(join(tmpdir(), 'crossorbit-')), 'test.db')}` : DATABASE_URL);
  if (!SQLITE) {
    await sql`DROP SCHEMA public CASCADE`.execute(db);
    await sql`CREATE SCHEMA public`.execute(db);
  }
  await migrate(db);
  await fake.start();
  app = createApp(db, new BookOrbit(fake.url, API_KEY), createLogger('error'));
});

afterAll(async () => {
  await db?.destroy();
  fake.server?.close();
});

describe('xpointer conversion', () => {
  const book = new EpubBook(fixtureEpub());

  it('round trips text positions', () => {
    expect(xpointerToCfi(book, '/body/DocFragment[1]/body/p[2]/text().7')).toEqual({ cfi: 'epubcfi(/6/2!/4/4/1:7)', exact: true });
    expect(cfiToXPointer(book, 'epubcfi(/6/2!/4/4/1:7)')).toEqual({ xpath: '/body/DocFragment[1]/body/p[2]/text().7', spine: 0 });
    expect(cfiToXPointer(book, 'epubcfi(/6/2!/4/4,/1:0,/1:6)')?.xpath).toBe('/body/DocFragment[1]/body/p[2]/text().0');
  });

  it('counts code points and falls back to the chapter', () => {
    const cfi = xpointerToCfi(book, '/body/DocFragment[2]/body/p/text()[1].6')!.cfi;
    expect(cfi).toBe('epubcfi(/6/4!/4/4/1:7)');
    expect(cfiToXPointer(book, cfi)?.xpath).toBe('/body/DocFragment[2]/body/p/text()[1].6');
    expect(xpointerToCfi(book, '/body/DocFragment[1]/body/div[9]')).toEqual({ cfi: 'epubcfi(/6/2)', exact: false });
    expect(xpointerToCfi(book, '/body/DocFragment[9]/body')).toBeNull();
  });
});

describe('bookmark sync', () => {
  it('rejects bad credentials and answers the probe', async () => {
    expect((await call('GET', `/api/v1/bookmarks/${HASH}?cursor=0&limit=1`, undefined, { 'x-auth-user': 'x', 'x-auth-key': 'y' })).status).toBe(401);
    const probe = await call('GET', `/api/v1/bookmarks/${HASH}?cursor=0&limit=1`);
    expect(probe).toEqual({ status: 200, body: { document: HASH, sync_version: 2, cursor: 0, more: false, items: [] } });
    expect((await call('GET', `/api/v1/bookmarks/${HASH}?cursor=0&limit=101`)).status).toBe(400);
  });

  it('pushes, renames and deletes device bookmarks', async () => {
    const a = mark('/body/DocFragment[1]/body/p[2]/text().7', { vo: 30 });
    const b = mark('/body/DocFragment[1]/body/div[3]', { name: 'Lost spot' });
    const push = await call('PUT', `/api/v1/bookmarks/${HASH}`, { items: [a, b] });
    expect(push).toEqual({ status: 200, body: { accepted: 2 } });
    expect(fake.bookmarks).toEqual([
      { id: 500, bookId: 1, cfi: 'epubcfi(/6/2!/4/4/1:7)', title: 'Hello brave new world.', bookFileId: 11 },
      { id: 501, bookId: 1, cfi: 'epubcfi(/6/2)', title: 'Lost spot', bookFileId: 11 },
    ]);

    await call('PUT', `/api/v1/bookmarks/${HASH}`, { items: [a] });
    expect(fake.bookmarks).toHaveLength(2);

    await call('PUT', `/api/v1/bookmarks/${HASH}`, { items: [{ ...a, name: 'Renamed' }] });
    expect(fake.bookmarks[0].title).toBe('Renamed');

    await call('PUT', `/api/v1/bookmarks/${HASH}`, { items: [{ id: b.id, deleted: 1 }] });
    expect(fake.bookmarks.map((x) => x.id)).toEqual([500]);

    const items = latest(await pullAll());
    expect(items.get(a.id)).toEqual({ ...a, name: 'Renamed' });
    expect(items.get(b.id)).toEqual({ id: b.id, deleted: 1 });
  });

  it('rejects malformed batches', async () => {
    expect((await call('PUT', `/api/v1/bookmarks/${HASH}`, { items: [{ id: 'nothex', deleted: 0 }] })).status).toBe(400);
    expect((await call('PUT', `/api/v1/bookmarks/${HASH}`, { items: Array(51).fill({ id: '0123456789abcdef', deleted: 1 }) })).status).toBe(400);
  });

  it('mirrors BookOrbit renames, deletions and new bookmarks with device ids', async () => {
    const a = bookmarkIdFor('/body/DocFragment[1]/body/p[2]/text().7');
    fake.bookmarks[0].title = 'From web';
    fake.bookmarks.push({ id: 900, bookId: 1, cfi: 'epubcfi(/6/4!/4/4/1:7)', title: 'Web mark' });
    fake.bookmarks.push({ id: 901, bookId: 1, cfi: 'garbage', title: 'Broken' });
    let items = latest(await pullAll());
    expect(items.get(a)).toMatchObject({ name: 'From web', deleted: 0 });
    const xpath = '/body/DocFragment[2]/body/p/text()[1].6';
    expect(items.get(bookmarkIdFor(xpath))).toMatchObject({ deleted: 0, xpath, si: 1, name: 'Web mark', percentage: 0.5 });
    expect(items.get('bookorbit-901')).toEqual({ id: 'bookorbit-901', deleted: 1 });

    // Device echoes the adopted bookmark back; nothing is duplicated upstream.
    await call('PUT', `/api/v1/bookmarks/${HASH}`, { items: [items.get(bookmarkIdFor(xpath))] });
    expect(fake.bookmarks.filter((b) => b.title === 'Web mark')).toHaveLength(1);

    fake.bookmarks = fake.bookmarks.filter((b) => b.id !== 500);
    items = latest(await pullAll(5));
    expect(items.get(a)).toEqual({ id: a, deleted: 1 });
  });

  it('returns an empty page for unknown books', async () => {
    const res = await call('GET', '/api/v1/bookmarks/ffffffffffffffffffffffffffffffff?cursor=0&limit=1');
    expect(res.body).toMatchObject({ sync_version: 2, more: false, items: [] });
  });
});

describe('reading sessions', () => {
  const session = (id: string, document = HASH) => ({
    session_id: id, document, started_at: 1_750_000_000, ended_at: 1_750_000_600, seconds: 540, utc_offset_minutes: 60,
  });

  it('acks every session and uploads resolvable ones once', async () => {
    expect((await call('PUT', '/api/v1/stats/sessions', { device_id: 'd', items: [session('s1')] }, { 'x-auth-user': 'x', 'x-auth-key': 'y' })).status).toBe(401);
    const res = await call('PUT', '/api/v1/stats/sessions', { device_id: 'd', items: [session('s1'), session('s2', LATE)] });
    expect(res).toEqual({ status: 200, body: { accepted_session_ids: ['s1', 's2'] } });
    expect(fake.sessions).toEqual([{
      fileId: 11, sessionId: 'crosspoint:s1', startedAt: '2025-06-15T15:06:40.000Z', endedAt: '2025-06-15T15:16:40.000Z', durationSeconds: 540,
    }]);
    await call('PUT', '/api/v1/stats/sessions', { device_id: 'd', items: [session('s1')] });
    expect(fake.sessions).toHaveLength(1);
  });

  it('retries pending sessions on later uploads', async () => {
    fake.failSessions = true;
    expect((await call('PUT', '/api/v1/stats/sessions', { device_id: 'd', items: [session('s3')] })).body).toEqual({ accepted_session_ids: ['s3'] });
    fake.failSessions = false;
    await db.deleteFrom('documents').where('document', '=', LATE).execute();
    fake.lateKnown = true;
    await call('PUT', '/api/v1/stats/sessions', { device_id: 'd', items: [] });
    expect(fake.sessions.map((s) => [s.sessionId, s.fileId])).toEqual([['crosspoint:s1', 11], ['crosspoint:s2', 22], ['crosspoint:s3', 11]]);
    const rows = await db.selectFrom('reading_sessions').select(['session_id', 'status']).orderBy('session_id').execute();
    expect(rows).toEqual([{ session_id: 's1', status: 'uploaded' }, { session_id: 's2', status: 'uploaded' }, { session_id: 's3', status: 'uploaded' }]);
  });

  it('rejects malformed batches', async () => {
    expect((await call('PUT', '/api/v1/stats/sessions', { device_id: 'd', items: [{ ...session('x'), document: 'nope' }] })).status).toBe(400);
    expect((await call('PUT', '/api/v1/stats/sessions', { device_id: 'd', items: Array.from({ length: 21 }, (_, i) => session(`b${i}`)) })).status).toBe(400);
  });

  it('records metrics', async () => {
    const text = await registry.metrics();
    expect(text).toMatch(/crossorbit_bookmarks_total\{direction="to_bookorbit",kind="created"\} [1-9]/);
    expect(text).toMatch(/crossorbit_bookmarks_total\{direction="to_device",kind="created"\} [1-9]/);
    expect(text).toMatch(/crossorbit_reading_sessions_total\{outcome="uploaded"\} [1-9]/);
  });
});
