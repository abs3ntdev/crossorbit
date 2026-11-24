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
import { FakeExchange } from './fake-exchange.js';
import { fixtureEpub } from './fixture.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://bookorbit:bookorbit@localhost:55432/crossorbit_test';
const SQLITE = DATABASE_URL.startsWith('sqlite:');
const HASH = '0123456789abcdef0123456789abcdef';
const LATE = 'fedcba9876543210fedcba9876543210';
const AUTH = { 'x-auth-user': 'reader', 'x-auth-key': '5f4dcc3b5aa765d61d8327deb882cf99' };
const API_KEY = 'bok_test';

class FakeBookOrbit {
  exchange = new FakeExchange((hash) => hash === HASH || (this.lateKnown && hash === LATE));
  progress: unknown[] = [];
  requests: string[] = [];
  failDownload = false;
  hang = false;
  lateKnown = false;
  forbidden = false;
  matchBodies: Record<string, unknown>[] = [];
  server!: Server;
  url = '';

  async start() {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      const path = req.url ?? '';
      this.requests.push(`${req.method} ${path}`);
      if (this.hang) return;
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
          if (!body.hashes.every((h: string) => /^[0-9a-f]{32}$/i.test(h))) return json(400, { message: ['each value in hashes must match'] });
          this.matchBodies.push(body);
          const matches = body.hashes.includes(HASH) ? [{ hash: HASH, bookId: 1, bookFileId: 11 }] : [];
          if (this.lateKnown && body.hashes.includes(LATE)) matches.push({ hash: LATE, bookId: 1, bookFileId: 11 });
          return json(201, { matches, libraryVersion: 'v' });
        }
        if (path === '/api/v1/koreader/syncs/progress' && req.method === 'PUT') {
          if ('position' in body) return json(400, { message: 'property position should not exist' });
          if (body.document !== HASH && !(this.lateKnown && body.document === LATE)) return json(404, { message: 'Book not found for the given document hash' });
          this.progress.push(body);
          return json(200, { document: body.document, timestamp: 1 });
        }
        if (path.startsWith('/api/v1/koreader/syncs/progress/')) return json(200, this.progress.at(-1) ?? {});
        const exchanged = this.exchange.handle(path, body);
        if (exchanged) return json(exchanged.status, exchanged.value);
      }
      if (req.headers['x-api-key'] !== API_KEY) return json(401);
      if (this.forbidden) return json(403, { message: 'This API key is read-only', errorCode: 'API_KEY_READ_ONLY' });
      if (path === '/api/v1/books/files/11/serve') {
        if (this.failDownload) return json(500);
        res.writeHead(200, { 'content-type': 'application/epub+zip' });
        return res.end(Buffer.from(fixtureEpub()));
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

  const P = (n: number, offset: number) => `/body/DocFragment[1]/body/p[${n}]/text().${offset}`;
  const sent = () => fake.exchange.bodies.filter((b) => b.path.endsWith('/annotations/exchange'));

  it('runs probe, deletion, upload, and paged pull through the annotation exchange', async () => {
    const web = fake.exchange.addAnnotation({ text: 'paragraph', pos0: P(2, 7), pos1: P(2, 16), chapter: 'Web' });

    const probe = await call('GET', `/api/v1/clippings/${HASH}?cursor=0&limit=1&format=reader`);
    expect(probe.status).toBe(200);
    expect(probe.body).toMatchObject({ document: HASH, sync_version: 2, more: false });
    expect(probe.body.items).toEqual([
      expect.objectContaining({ id: `bookorbit-${web.id}`, deleted: 0, spine: 0, start_offset: 29, end_offset: 38, text: 'paragraph', chapter: 'Web', layout_signature: 0, pages: 1 }),
    ]);
    expect(web.key).not.toBeNull();
    expect(sent().at(-1)!.body).toMatchObject({
      deviceId: expect.stringMatching(/^crossorbit-[0-9a-f]{24}$/), deviceModel: 'CrossPoint', pluginVersion: expect.any(String),
      books: [{ hash: HASH, sidecarState: 'known', keysComplete: true }],
    });

    const deletion = await call('PUT', `/api/v1/clippings/${HASH}`, { items: [{ id: 'never-synced', deleted: 1 }] });
    expect(deletion.body).toMatchObject({ accepted: 1 });

    const upload = await call('PUT', `/api/v1/clippings/${HASH}`, { items: [clip('dev1', 'brave new', 6)] });
    expect(upload.body).toMatchObject({ accepted: 1 });
    expect(fake.exchange.live('brave new')).toEqual([expect.objectContaining({ pos0: P(1, 6), pos1: P(1, 15), chapter: 'One' })]);
    const datetime = fake.exchange.live('brave new')[0].datetime;
    expect(datetime).toBe('2023-11-14 22:13:20');

    await call('PUT', `/api/v1/clippings/${HASH}`, { items: [clip('dev2', 'Second paragraph', 0)] });
    expect(fake.exchange.live('Second paragraph')).toEqual([expect.objectContaining({ pos0: P(2, 0), pos1: P(2, 16) })]);
    // Same created_at: KOReader identity needs distinct datetimes.
    expect(fake.exchange.live('Second paragraph')[0].datetime).not.toBe(datetime);

    const items = await pullAll();
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(byId.get('never-synced')).toEqual({ id: 'never-synced', revision: expect.any(Number), deleted: 1 });
    expect(byId.get('dev1')).toEqual({ ...clip('dev1', 'brave new', 6), revision: expect.any(Number), deleted: 0 });
    expect(byId.get(`bookorbit-${web.id}`)).toMatchObject({ deleted: 0 });
    expect(items).toHaveLength(4);
  });

  it('reports device deletions through the key list and mirrors BookOrbit deletions', async () => {
    await call('PUT', `/api/v1/clippings/${HASH}`, { items: [{ id: 'dev1', deleted: 1 }] });
    expect(fake.exchange.live('brave new')).toHaveLength(0);
    await call('PUT', `/api/v1/clippings/${HASH}`, { items: [clip('dev1', 'brave new', 6)] });
    expect(fake.exchange.live('brave new')).toHaveLength(0);

    fake.exchange.live('paragraph')[0].deleted = true;
    const items = await pullAll();
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(byId.get('dev1')).toMatchObject({ deleted: 1 });
    expect(items.filter((i) => i.deleted === 1)).toHaveLength(3);
    expect(byId.get('dev2')).toMatchObject({ deleted: 0 });
    expect(fake.exchange.annotations.filter((a) => a.deleted && a.key)).toEqual([]);
  });

  it('mirrors BookOrbit edits onto the device clipping', async () => {
    const row = fake.exchange.live('Second paragraph')[0];
    fake.exchange.editAnnotation(row, { text: 'Second', pos1: P(2, 6), note: 'web note' });
    const items = await pullAll();
    expect(items.find((i) => i.id === 'dev2')).toMatchObject({ deleted: 0, text: 'Second', start_offset: 22, end_offset: 28 });
    const stored = await db.selectFrom('clippings').select(['note', 'ko_key']).where('clipping_id', '=', 'dev2').executeTakeFirstOrThrow();
    expect(stored.note).toBe('web note');
    expect(row.linked).toBe(row.version);
  });

  it('retries mirroring when the EPUB download fails', async () => {
    const hello = fake.exchange.addAnnotation({ text: 'Hello', pos0: P(1, 0), pos1: P(1, 5) });
    fake.failDownload = true;
    const shared = app;
    app = createApp(db, new BookOrbit(fake.url, API_KEY), createLogger('error'));
    const failed = await pullAll().finally(() => { app = shared; });
    expect(failed.some((i) => i.id === `bookorbit-${hello.id}`)).toBe(false);
    fake.failDownload = false;
    expect((await pullAll()).find((i) => i.text === 'Hello')).toMatchObject({ deleted: 0 });
  });

  it('re-anchors on offset moves and keeps the old anchor when the new one fails', async () => {
    await call('PUT', `/api/v1/clippings/${HASH}`, { items: [clip('dev3', 'world', 16)] });
    expect(fake.exchange.live('world')).toEqual([expect.objectContaining({ pos0: P(1, 16) })]);
    await call('PUT', `/api/v1/clippings/${HASH}`, { items: [clip('dev3', 'world', 1)] });
    // Offset 1 does not hold the text, so the anchor falls back to finding it: still one highlight at 16.
    expect(fake.exchange.live('world')).toEqual([expect.objectContaining({ pos0: P(1, 16) })]);
    const before = await db.selectFrom('clippings').select(['ko_key', 'pos0']).where('clipping_id', '=', 'dev3').executeTakeFirstOrThrow();
    await call('PUT', `/api/v1/clippings/${HASH}`, { items: [clip('dev3', 'absent', 16)] });
    expect(fake.exchange.live('world')).toHaveLength(1);
    const after = await db.selectFrom('clippings').select(['ko_key', 'pos0']).where('clipping_id', '=', 'dev3').executeTakeFirstOrThrow();
    expect(after).toEqual(before);
  });

  it('pages through more than one batch of BookOrbit highlights', async () => {
    const made = Array.from({ length: 60 }, () => fake.exchange.addAnnotation({ text: 'Second', pos0: P(2, 0), pos1: P(2, 6) }));
    const items = await pullAll();
    expect(items.filter((i) => i.text === 'Second' && i.deleted === 0).length).toBeGreaterThanOrEqual(60);
    expect(made.every((a) => a.key)).toBe(true);
    for (const a of made) a.deleted = true;
    const ids = new Set(made.map((a) => `bookorbit-${a.id}`));
    expect((await pullAll()).filter((i) => ids.has(i.id as string) && i.deleted === 0)).toHaveLength(0);
  });

  it('serializes concurrent pushes of the same clipping', async () => {
    const push = () => call('PUT', `/api/v1/clippings/${HASH}`, { items: [clip('dev4', 'Hello brave', 0)] });
    await Promise.all([push(), push(), push()]);
    expect(fake.exchange.live('Hello brave')).toHaveLength(1);
  });

  it('keeps clippings pending and reports a book BookOrbit cannot position', async () => {
    fake.exchange.incompatible.add(HASH);
    try {
      await call('PUT', `/api/v1/clippings/${HASH}`, { items: [clip('dev5', 'new world', 10)] });
      expect(fake.exchange.live('new world')).toHaveLength(0);
      const problem = await db.selectFrom('exchange_problems').select(['kind', 'problem']).where('document', '=', HASH).execute();
      expect(problem).toEqual([{ kind: 'clipping', problem: 'position_incompatible' }]);
    } finally {
      fake.exchange.incompatible.delete(HASH);
    }
    await pullAll();
    expect(fake.exchange.live('new world')).toHaveLength(1);
    expect(await db.selectFrom('exchange_problems').selectAll().where('document', '=', HASH).execute()).toEqual([]);
  });

  it('returns an empty page for unknown books', async () => {
    const res = await call('GET', `/api/v1/clippings/ffffffffffffffffffffffffffffffff?cursor=0&limit=1&format=reader`);
    expect(res.body).toMatchObject({ sync_version: 2, cursor: 0, more: false, items: [] });
  });
});

describe('unmatched books and fixes from the audit', () => {
  it('accepts clippings and progress for an unmatched book and replays them once it matches', async () => {
    const put = await call('PUT', `/api/v1/clippings/${LATE}`, { items: [clip('late1', 'Hello', 0)] });
    expect(put).toEqual({ status: 200, body: { until: expect.any(Number), accepted: 1 } });
    const progress = await call('PUT', '/syncs/progress', {
      document: LATE, progress: '/body/DocFragment[1]/body/p[1]', percentage: 0.1, device: 'CrossPoint', device_id: 'abc',
      metadata: { title: 'Late Book', authors: 'A. Writer' },
    });
    expect(progress).toEqual({ status: 200, body: { document: LATE, timestamp: expect.any(Number) } });
    expect(fake.matchBodies.at(-1)).toMatchObject({
      hashes: [LATE], books: [{ hash: LATE, source: 'current_file', title: 'Late Book', authors: 'A. Writer' }],
    });
    const pendingRows = await db.selectFrom('pending_items').select(['document', 'item_id']).execute();
    expect(pendingRows).toEqual([{ document: LATE, item_id: 'late1' }]);

    fake.lateKnown = true;
    const pulled = await call('GET', `/syncs/progress/${LATE}`);
    expect(pulled.body).toMatchObject({ document: LATE, percentage: 0.1 });
    expect(await db.selectFrom('pending_progress').selectAll().execute()).toEqual([]);

    const page = await call('GET', `/api/v1/clippings/${LATE}?cursor=0&limit=50&format=reader`);
    expect(page.status).toBe(200);
    const row = await db.selectFrom('clippings').select(['deleted', 'text', 'ko_key']).where('clipping_id', '=', 'late1').executeTakeFirstOrThrow();
    expect(row).toMatchObject({ text: 'Hello' });
    expect(Boolean(row.deleted)).toBe(false);
    expect(fake.exchange.annotations.some((a) => a.key === row.ko_key && !a.deleted)).toBe(true);
    expect(await db.selectFrom('pending_items').selectAll().execute()).toEqual([]);
  });

  it('never sends non-MD5 documents to match-check', async () => {
    const before = fake.matchBodies.length;
    const put = await call('PUT', '/api/v1/clippings/book.epub', { items: [clip('odd1', 'Hello', 0)] });
    expect(put.body).toMatchObject({ accepted: 1 });
    expect((await call('GET', '/api/v1/clippings/book.epub?cursor=0&limit=1')).body).toMatchObject({ items: [], more: false });
    expect(fake.matchBodies.length).toBe(before);
    const bad = await call('PUT', '/api/v1/clippings/book.epub', { items: [] }, { 'x-auth-user': 'x', 'x-auth-key': 'y' });
    expect(bad.status).toBe(401);
  });

  it('answers malformed requests like crosspoint-sync', async () => {
    expect(await call('GET', '/api/v1/clippings/bad%20doc?cursor=0')).toEqual({ status: 403, body: { code: 2004, message: "Field 'document' not provided." } });
    expect((await call('PUT', `/api/v1/clippings/${HASH}`, { items: [{ id: '' }] })).body).toMatchObject({ code: 2003 });
    expect((await call('GET', `/api/v1/clippings/${HASH}?cursor=-1`)).status).toBe(403);
  });

  it('stores only valid rich positions', async () => {
    await db.deleteFrom('positions').execute();
    const send = (position: unknown) => call('PUT', '/syncs/progress', { document: HASH, progress: '/x', percentage: 0.3, device: 'CrossPoint', device_id: 'abc', position });
    await send({ pctQ: 2_000_000, spine: 0, page: 0, pages: 1 });
    await send({ pctQ: 1, spine: 70000, page: 0, pages: 1 });
    await send({ pctQ: 1, spine: 0, page: 0, pages: 1, xpath: 'x'.repeat(121) });
    expect(await db.selectFrom('positions').selectAll().execute()).toEqual([]);
    await send({ pctQ: 300000, spine: 2, page: 1, pages: 4, para: 3, extra: 'dropped' });
    const row = await db.selectFrom('positions').select('position').executeTakeFirstOrThrow();
    expect(typeof row.position === 'string' ? JSON.parse(row.position) : row.position).toEqual({ pctQ: 300000, spine: 2, page: 1, pages: 4, para: 3 });
  });

  it('checks device credentials once per minute across paged pulls', async () => {
    await pullAll();
    const before = fake.requests.filter((r) => r.endsWith('/koreader/users/auth')).length;
    await pullAll();
    await pullAll();
    expect(fake.requests.filter((r) => r.endsWith('/koreader/users/auth')).length).toBe(before);
  });

  it('explains a refused API key', async () => {
    fake.forbidden = true;
    const shared = app;
    app = createApp(db, new BookOrbit(fake.url, API_KEY), createLogger('error'));
    try {
      const res = await call('PUT', `/api/v1/clippings/${HASH}`, { items: [clip('ro1', 'Hello brave new', 0)] });
      expect(res.status).toBe(502);
      expect(res.body.message).toContain('API key');
      expect(res.body.message).toContain('This API key is read-only');
    } finally {
      fake.forbidden = false;
      app = shared;
    }
  });
});

describe('upstream timeouts', () => {
  it('aborts hung BookOrbit requests', async () => {
    const client = new BookOrbit(fake.url, API_KEY, { request: 50, download: 50 });
    fake.hang = true;
    try {
      expect(await client.ping()).toBe(false);
      await expect(client.downloadFile(11)).rejects.toThrow();
    } finally {
      fake.hang = false;
    }
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
