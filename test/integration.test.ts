import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { BookOrbit } from '../src/bookorbit.js';
import { sql } from 'kysely';

import { connect, type Db, migrate } from '../src/db.js';
import { createLogger } from '../src/log.js';
import { registry, trackStorage } from '../src/metrics.js';
import { fixtureEpub } from './fixture.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://bookorbit:bookorbit@localhost:55432/crossorbit_test';
const SQLITE = DATABASE_URL.startsWith('sqlite:');
const HASH = '0123456789abcdef0123456789abcdef';
const AUTH = { 'x-auth-user': 'reader', 'x-auth-key': '5f4dcc3b5aa765d61d8327deb882cf99' };
const API_KEY = 'bok_test';

interface FakeAnnotation {
  id: number;
  bookId: number;
  cfi: string;
  text: string;
  chapterTitle: string | null;
  createdAt: string;
}

class FakeBookOrbit {
  annotations: FakeAnnotation[] = [];
  progress: unknown[] = [];
  requests: string[] = [];
  nextId = 100;
  failDownload = false;
  server!: Server;
  url = '';

  async start() {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      const path = req.url ?? '';
      this.requests.push(`${req.method} ${path}`);
      const json = (status: number, value?: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(value === undefined ? '' : JSON.stringify(value));
      };
      if (path.startsWith('/api/v1/koreader/')) {
        if (req.headers['x-auth-user'] !== AUTH['x-auth-user'] || req.headers['x-auth-key'] !== AUTH['x-auth-key']) {
          return json(401, { message: 'Unauthorized' });
        }
        if (path === '/api/v1/koreader/users/auth') return json(200, { authorized: 'OK', username: 'reader' });
        if (path === '/api/v1/koreader/plugin/match-check') {
          if (!body.deviceId || !body.deviceModel || !body.pluginVersion) return json(400);
          return json(201, { matches: body.hashes.includes(HASH) ? [{ hash: HASH, bookId: 1, bookFileId: 11 }] : [], libraryVersion: 'v' });
        }
        if (path === '/api/v1/koreader/syncs/progress' && req.method === 'PUT') {
          if ('position' in body) return json(400, { message: 'property position should not exist' });
          this.progress.push(body);
          return json(200, { document: body.document, timestamp: 1 });
        }
        if (path.startsWith('/api/v1/koreader/syncs/progress/')) return json(200, this.progress.at(-1) ?? {});
      }
      if (req.headers['x-api-key'] !== API_KEY) return json(401);
      if (path === '/api/v1/books/files/11/serve') {
        if (this.failDownload) return json(500);
        res.writeHead(200, { 'content-type': 'application/epub+zip' });
        return res.end(Buffer.from(fixtureEpub()));
      }
      const m = /^\/api\/v1\/books\/1\/annotations(?:\/(\d+))?(?:\?.*)?$/.exec(path);
      if (m && req.method === 'GET') return json(200, this.annotations);
      if (m && req.method === 'POST') {
        const a = { id: this.nextId++, bookId: 1, cfi: body.cfi, text: body.text, chapterTitle: body.chapterTitle, createdAt: new Date().toISOString() };
        this.annotations.push(a);
        return json(201, a);
      }
      if (m?.[1] && req.method === 'DELETE') {
        this.annotations = this.annotations.filter((a) => a.id !== Number(m[1]));
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

const clip = (id: string, text: string, start: number, extra: Record<string, unknown> = {}) => ({
  id, spine: 0, start_page: 0, end_page: 0, pages: 3, start_word: 1, end_word: 2, words: 2, para: 1, chapter: 'One',
  text, created_at: 1700000000, layout_signature: 12345, start_offset: start, end_offset: start + text.length, ...extra,
});

async function pullAll() {
  const items: Record<string, unknown>[] = [];
  let cursor = 0;
  for (;;) {
    const { status, body } = await call('GET', `/api/v1/clippings/${HASH}?limit=1&format=reader&cursor=${cursor}`);
    expect(status).toBe(200);
    expect(typeof body.cursor).toBe('number');
    expect(typeof body.more).toBe('boolean');
    expect(body.items.length).toBeLessThanOrEqual(1);
    if (body.items.length) expect(body.cursor).toBeGreaterThan(cursor);
    if (body.more) expect(body.items.length).toBe(1);
    items.push(...body.items);
    cursor = body.cursor;
    if (!body.more) return items;
  }
}

beforeAll(async () => {
  db = connect(SQLITE ? `sqlite:${join(mkdtempSync(join(tmpdir(), 'crossorbit-')), 'test.db')}` : DATABASE_URL);
  if (!SQLITE) {
    await sql`DROP SCHEMA public CASCADE`.execute(db);
    await sql`CREATE SCHEMA public`.execute(db);
  }
  await migrate(db);
  await migrate(db);
  await fake.start();
  app = createApp(db, new BookOrbit(fake.url, API_KEY), createLogger('error'));
});

afterAll(async () => {
  await db?.destroy();
  fake.server?.close();
});

describe('kosync proxy', () => {
  it('authenticates through BookOrbit', async () => {
    expect((await call('GET', '/users/auth')).status).toBe(200);
    expect((await call('GET', '/users/auth', undefined, { 'x-auth-user': 'reader', 'x-auth-key': 'bad' })).status).toBe(401);
    expect((await call('POST', '/users/create', { username: 'a', password: 'b' })).status).toBe(403);
  });

  it('strips position and falls back to its xpath', async () => {
    const put = await call('PUT', '/syncs/progress', {
      document: HASH, progress: '', percentage: 0.25, device: 'CrossPoint', device_id: 'abc',
      metadata: { title: 'Fixture' }, position: { pctQ: 1, spine: 0, page: 1, pages: 3, xpath: '/body/DocFragment[1]/body/p[2]' },
    });
    expect(put.status).toBe(200);
    expect(fake.progress.at(-1)).toEqual({
      document: HASH, progress: '/body/DocFragment[1]/body/p[2]', percentage: 0.25, device: 'CrossPoint', device_id: 'abc', metadata: { title: 'Fixture' },
    });
    const get = await call('GET', `/syncs/progress/${HASH}?position_kinds=locator,percentage`);
    expect(get.body).toMatchObject({ progress: '/body/DocFragment[1]/body/p[2]', percentage: 0.25 });
  });

  it('restores the device position while BookOrbit progress is unchanged', async () => {
    const position = { pctQ: 2500, spine: 3, page: 4, pages: 9, para: 12, xpath: '/body/DocFragment[4]/body/p[12]' };
    await call('PUT', '/syncs/progress', { document: HASH, progress: '', percentage: 0.4, device: 'CrossPoint', device_id: 'abc', position });
    const get = await call('GET', `/syncs/progress/${HASH}`);
    expect(get.body).toMatchObject({ percentage: 0.4, position });
  });

  it('drops the stored position once progress moves elsewhere', async () => {
    fake.progress.push({ document: HASH, progress: 'epubcfi(/6/8!/4/2)', percentage: 0.5, device: 'Web' });
    const get = await call('GET', `/syncs/progress/${HASH}`);
    expect(get.body).toMatchObject({ percentage: 0.5 });
    expect(get.body).not.toHaveProperty('position');
  });
});

describe('firmware clipping sequence', () => {
  it('rejects bad credentials', async () => {
    const res = await call('GET', `/api/v1/clippings/${HASH}?cursor=0&limit=1&format=reader`, undefined, { 'x-auth-user': 'x', 'x-auth-key': 'y' });
    expect(res.status).toBe(401);
  });

  it('runs probe, deletion, upload, and paged pull', async () => {
    fake.annotations.push({ id: 7, bookId: 1, cfi: 'epubcfi(/6/2!/4/4,/1:7,/1:16)', text: 'paragraph', chapterTitle: 'Web', createdAt: '2026-01-01T00:00:00.000Z' });

    const probe = await call('GET', `/api/v1/clippings/${HASH}?cursor=0&limit=1&format=reader`);
    expect(probe.status).toBe(200);
    expect(probe.body).toMatchObject({ document: HASH, sync_version: 2, more: false });
    expect(probe.body.items).toEqual([
      expect.objectContaining({ deleted: 0, spine: 0, start_offset: 29, end_offset: 38, text: 'paragraph', chapter: 'Web', layout_signature: 0, pages: 1 }),
    ]);
    const webId = probe.body.items[0].id as string;

    const deletion = await call('PUT', `/api/v1/clippings/${HASH}`, { items: [{ id: 'never-synced', deleted: 1 }] });
    expect(deletion.body).toMatchObject({ accepted: 1 });

    const upload = await call('PUT', `/api/v1/clippings/${HASH}`, { items: [clip('dev1', 'brave new', 6)] });
    expect(upload.body).toMatchObject({ accepted: 1 });
    expect(fake.annotations.find((a) => a.text === 'brave new')?.cfi).toBe('epubcfi(/6/2!/4/2,/1:6,/1:15)');

    await call('PUT', `/api/v1/clippings/${HASH}`, { items: [clip('dev2', 'Second paragraph', 0)] });
    expect(fake.annotations.find((a) => a.text === 'Second paragraph')?.cfi).toBe('epubcfi(/6/2!/4/4,/1:0,/1:16)');

    const items = await pullAll();
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(byId.get('never-synced')).toEqual({ id: 'never-synced', revision: expect.any(Number), deleted: 1 });
    expect(byId.get('dev1')).toEqual({ ...clip('dev1', 'brave new', 6), revision: expect.any(Number), deleted: 0 });
    expect(byId.get(webId)).toMatchObject({ deleted: 0 });
    expect(items).toHaveLength(4);
  });

  it('never resurrects tombstones and mirrors BookOrbit deletions', async () => {
    const dev1 = fake.annotations.find((a) => a.text === 'brave new')!;
    await call('PUT', `/api/v1/clippings/${HASH}`, { items: [{ id: 'dev1', deleted: 1 }] });
    expect(fake.annotations.some((a) => a.id === dev1.id)).toBe(false);
    await call('PUT', `/api/v1/clippings/${HASH}`, { items: [clip('dev1', 'brave new', 6)] });
    expect(fake.annotations.some((a) => a.text === 'brave new')).toBe(false);

    fake.annotations = fake.annotations.filter((a) => a.id !== 7);
    const items = await pullAll();
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(byId.get('dev1')).toMatchObject({ deleted: 1 });
    expect(items.filter((i) => i.deleted === 1)).toHaveLength(3);
    expect(byId.get('dev2')).toMatchObject({ deleted: 0 });
  });

  it('retries mirroring when the EPUB download fails', async () => {
    fake.annotations.push({ id: 8, bookId: 1, cfi: 'epubcfi(/6/2!/4/2,/1:0,/1:5)', text: 'Hello', chapterTitle: null, createdAt: '2026-01-02T00:00:00.000Z' });
    fake.failDownload = true;
    const shared = app;
    app = createApp(db, new BookOrbit(fake.url, API_KEY), createLogger('error'));
    const failed = await pullAll().finally(() => { app = shared; });
    expect(failed.some((i) => i.id === 'bookorbit-8' || i.text === 'Hello')).toBe(false);
    fake.failDownload = false;
    expect((await pullAll()).find((i) => i.text === 'Hello')).toMatchObject({ deleted: 0 });
  });

  it('returns an empty page for unknown books', async () => {
    const res = await call('GET', `/api/v1/clippings/ffffffffffffffffffffffffffffffff?cursor=0&limit=1&format=reader`);
    expect(res.body).toMatchObject({ sync_version: 2, cursor: 0, more: false, items: [] });
  });
});

describe('metrics', () => {
  it('records the sync traffic above', async () => {
    trackStorage(db);
    const text = await registry.metrics();
    expect(text).toMatch(/crossorbit_http_requests_total\{method="GET",route="\/api\/v1\/clippings\/:document",status="200"\} \d+/);
    expect(text).toMatch(/crossorbit_clippings_total\{direction="to_bookorbit",kind="created"\} [1-9]/);
    expect(text).toMatch(/crossorbit_clippings_total\{direction="to_device",kind="deleted"\} [1-9]/);
    expect(text).toMatch(/crossorbit_bookorbit_requests_total\{operation="match_check",status="201"\} [1-9]/);
    expect(text).toMatch(/crossorbit_clippings_stored\{state="live"\} [1-9]/);
    expect(text).not.toMatch(/route="[^"]*[0-9a-f]{32}/);
  });
});
