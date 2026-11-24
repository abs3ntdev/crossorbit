import { Hono, type Context } from 'hono';
import { sql } from 'kysely';

import { BookOrbit, BookOrbitError, type DeviceAuth } from './bookorbit.js';
import { BookmarkService, decodeBookmarkBatch, type IncomingBookmark, parseBookmarkQuery } from './bookmarks.js';
import { ClippingService, type ResolvedFile } from './clippings.js';
import { decodeSessionBatch, SessionService } from './sessions.js';
import { type Db, now } from './db.js';
import type { Logger } from './log.js';
import { httpDuration, httpRequests, lastSync, progressSyncs } from './metrics.js';
import { PendingStore } from './pending.js';
import { decodeBatch, type IncomingItem, parsePageQuery, parsePosition, POSITION_XPATH_MAX, ProtocolError } from './protocol.js';

const DOCUMENT_RE = /^[A-Za-z0-9._-]{1,64}$/;
const HINT_MAX = 512;

function deviceAuth(c: Context): DeviceAuth | null {
  const user = c.req.header('x-auth-user');
  const key = c.req.header('x-auth-key');
  return user && key ? { user, key } : null;
}

function unauthorized(c: Context) {
  return c.json({ code: 2001, message: 'Unauthorized' }, 401);
}

class DocumentError extends Error {
  constructor() {
    super("Field 'document' not provided.");
  }
}

/** crosspoint-sync answers a malformed document with 403 / 2004. */
function checkDocument(document: string) {
  if (!DOCUMENT_RE.test(document)) throw new DocumentError();
}

async function relay(c: Context, res: Response) {
  const body = await res.text();
  if (res.status === 204 || !body) return c.body(null, res.status === 204 ? 204 : (res.status as 200));
  return c.newResponse(body, res.status as 200, { 'content-type': res.headers.get('content-type') ?? 'application/json' });
}

export function progressBody(raw: unknown): Record<string, unknown> {
  const body = { ...(raw as Record<string, unknown>) };
  const position = body.position as { xpath?: unknown } | undefined;
  delete body.position;
  if (!body.progress && typeof position?.xpath === 'string' && Buffer.byteLength(position.xpath) <= POSITION_XPATH_MAX) body.progress = position.xpath;
  return body;
}

/** Title and authors from the progress metadata, used to describe the book to BookOrbit's match-check. */
export function hintFrom(metadata: unknown): { title: string | null; authors: string | null } | null {
  if (typeof metadata !== 'object' || metadata === null) return null;
  const o = metadata as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, HINT_MAX) : null);
  const hint = { title: str(o.title), authors: str(o.authors) };
  return hint.title || hint.authors ? hint : null;
}

function samePercentage(a: unknown, b: number) {
  return typeof a === 'number' && Math.abs(a - b) < 1e-6;
}

export function createApp(db: Db, bookorbit: BookOrbit, log: Logger) {
  const app = new Hono();
  const clippings = new ClippingService(db, bookorbit, log);
  const bookmarks = new BookmarkService(db, bookorbit, clippings, log);
  const sessions = new SessionService(db, bookorbit, clippings, log);
  const pending = new PendingStore(db);

  /** Replays uploads that arrived while the book was still unmatched. */
  async function flush(auth: DeviceAuth, document: string, file: ResolvedFile) {
    const replayed = await pending.drain<IncomingItem>(auth.user, document, 'clipping', (items) => clippings.apply(file, items))
      + await pending.drain<IncomingBookmark>(auth.user, document, 'bookmark', (items) => bookmarks.apply(file, items));
    if (replayed) log.info('pending items replayed', { document, bookFileId: file.bookFileId, items: replayed });
  }

  /** Pushes a progress write stored while the book was unmatched, dropping it once BookOrbit accepts it. */
  async function flushProgress(auth: DeviceAuth, document: string) {
    const row = await db.selectFrom('pending_progress').select(['body']).where('username', '=', auth.user)
      .where('document', '=', document.toLowerCase()).executeTakeFirst();
    if (!row) return;
    const res = await bookorbit.device('/syncs/progress', auth, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: typeof row.body === 'string' ? row.body : JSON.stringify(row.body),
    });
    if (res.status === 401) throw new BookOrbitError(401, 'Unauthorized');
    if (res.ok) {
      await db.deleteFrom('pending_progress').where('username', '=', auth.user).where('document', '=', document.toLowerCase()).execute();
      log.info('pending progress replayed', { document });
    }
  }

  app.use('*', async (c, next) => {
    if (c.req.path === '/healthz') return next();
    const started = performance.now();
    await next();
    const route = c.req.routePath === '/*' ? 'unmatched' : c.req.routePath;
    httpRequests.inc({ method: c.req.method, route, status: String(c.res.status) });
    httpDuration.observe({ method: c.req.method, route }, (performance.now() - started) / 1000);
  });

  app.onError((error, c) => {
    if (error instanceof DocumentError) return c.json({ code: 2004, message: error.message }, 403);
    if (error instanceof ProtocolError) return c.json({ code: 2003, message: error.message }, 403);
    if (error instanceof BookOrbitError && error.status === 401) return unauthorized(c);
    if (error instanceof BookOrbitError && error.status === 403) {
      log.error('BookOrbit refused the request: check the API key has read and write access', { path: c.req.path, error: error.message });
      return c.json({ code: 2000, message: `BookOrbit refused the request, check the API key access: ${error.message}` }, 502);
    }
    log.error('request failed', { path: c.req.path, error: error.message });
    return c.json({ code: 2000, message: 'Upstream error' }, 502);
  });

  app.get('/healthz', async (c) => {
    await sql`SELECT 1`.execute(db);
    return c.json({ ok: true });
  });

  app.get('/users/auth', async (c) => {
    const auth = deviceAuth(c);
    if (!auth) return unauthorized(c);
    return relay(c, await bookorbit.device('/users/auth', auth));
  });

  app.post('/users/create', (c) => c.json({ code: 2005, message: 'Registration disabled. Create credentials in BookOrbit settings.' }, 403));

  app.put('/syncs/progress', async (c) => {
    const auth = deviceAuth(c);
    if (!auth) return unauthorized(c);
    const raw = await c.req.json().catch(() => ({}));
    const body = progressBody(raw);
    const { document, progress, percentage } = body;
    const hint = hintFrom(body.metadata);
    if (typeof document === 'string' && DOCUMENT_RE.test(document) && hint) {
      await db.insertInto('document_hints').values({ username: auth.user, document: document.toLowerCase(), ...hint })
        .onConflict((oc) => oc.columns(['username', 'document']).doUpdateSet({ ...hint, updated_at: now(db) }))
        .execute();
    }
    const res = await bookorbit.device('/syncs/progress', auth, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    log.info('progress pushed', { document, percentage, status: res.status });
    progressSyncs.inc({ direction: 'push', status: String(res.status) });
    // An unmatched book is kept and accepted, as kosync servers do, and replayed once BookOrbit knows it.
    const unmatched = res.status === 404 && typeof document === 'string' && DOCUMENT_RE.test(document);
    if (!res.ok && !unmatched) return relay(c, res);
    lastSync.setToCurrentTime({ kind: 'progress' });
    const position = parsePosition((raw as { position?: unknown }).position);
    if (position && typeof document === 'string' && typeof percentage === 'number') {
      const row = { progress: String(progress ?? ''), percentage, position };
      await db.insertInto('positions').values({ username: auth.user, document, ...row })
        .onConflict((oc) => oc.columns(['username', 'document']).doUpdateSet({ ...row, updated_at: now(db) }))
        .execute();
    }
    if (!unmatched) {
      if (typeof document === 'string') {
        await db.deleteFrom('pending_progress').where('username', '=', auth.user).where('document', '=', document.toLowerCase()).execute();
      }
      return relay(c, res);
    }
    const timestamp = typeof body.timestamp === 'number' ? Math.floor(body.timestamp) : Math.floor(Date.now() / 1000);
    const stored = { ...body, timestamp };
    await db.insertInto('pending_progress').values({ username: auth.user, document: document.toLowerCase(), body: stored, timestamp })
      .onConflict((oc) => oc.columns(['username', 'document']).doUpdateSet({ body: stored, timestamp, updated_at: now(db) }))
      .execute();
    // Lists the book in BookOrbit's unmatched books, with the title and authors when known.
    await bookorbit.resolve(document, auth, hint).catch((error: Error) => log.warn('match-check failed', { document, error: error.message }));
    log.warn('progress kept for unmatched book', { document });
    return c.json({ document, timestamp });
  });

  app.get('/syncs/progress/:document', async (c) => {
    const auth = deviceAuth(c);
    if (!auth) return unauthorized(c);
    const document = c.req.param('document');
    checkDocument(document);
    await flushProgress(auth, document);
    const res = await bookorbit.device(`/syncs/progress/${encodeURIComponent(document)}`, auth);
    const body = await res.clone().json().catch(() => null) as { percentage?: number; progress?: string; device?: string } | null;
    let restored = false;
    if (res.ok && body) {
      const saved = await db.selectFrom('positions').select(['progress', 'percentage', 'position'])
        .where('username', '=', auth.user).where('document', '=', document).executeTakeFirst();
      if (saved && saved.progress === (body.progress ?? '') && samePercentage(body.percentage, saved.percentage)) {
        restored = true;
        Object.assign(body, { position: typeof saved.position === 'string' ? JSON.parse(saved.position) : saved.position });
      }
    }
    log.info('progress pulled', { document, status: res.status, percentage: body?.percentage ?? null, device: body?.device ?? null, position: restored });
    progressSyncs.inc({ direction: 'pull', status: String(res.status) });
    if (res.ok) lastSync.setToCurrentTime({ kind: 'progress' });
    if (restored) return c.json(body);
    return relay(c, res);
  });

  app.get('/api/v1/clippings/:document', async (c) => {
    const auth = deviceAuth(c);
    if (!auth) return unauthorized(c);
    const document = c.req.param('document');
    checkDocument(document);
    const { cursor, limit } = parsePageQuery(c.req.query());
    const file = await clippings.resolve(document, auth);
    if (file && cursor === 0) await flush(auth, document, file);
    const page = await clippings.page(document, file, cursor, limit);
    log.info('clippings pulled', {
      document,
      bookFileId: file?.bookFileId ?? null,
      cursor,
      next: page.cursor,
      more: page.more,
      items: page.items.map((item) => `${(item as { id: string }).id}@${(item as { revision: number }).revision}${(item as { deleted: number }).deleted ? ':deleted' : ''}`),
    });
    lastSync.setToCurrentTime({ kind: 'clippings' });
    return c.json(page);
  });

  app.put('/api/v1/clippings/:document', async (c) => {
    const auth = deviceAuth(c);
    if (!auth) return unauthorized(c);
    const document = c.req.param('document');
    checkDocument(document);
    const items = decodeBatch(await c.req.json().catch(() => null));
    const file = await clippings.resolve(document, auth);
    if (!file) {
      await pending.put(auth.user, document, 'clipping', items);
      log.info('clippings kept for unmatched book', { document, items: items.map((item) => `${item.id}${item.deleted ? ':deleted' : ''}`) });
      return c.json({ until: Math.floor(Date.now() / 1000), accepted: items.length });
    }
    await flush(auth, document, file);
    await clippings.apply(file, items);
    log.info('clippings pushed', {
      document,
      bookFileId: file.bookFileId,
      items: items.map((item) => `${item.id}${item.deleted ? ':deleted' : ''}`),
    });
    return c.json({ until: Math.floor(Date.now() / 1000), accepted: items.length });
  });

  app.get('/api/v1/bookmarks/:document', async (c) => {
    const auth = deviceAuth(c);
    if (!auth) return unauthorized(c);
    const document = c.req.param('document');
    checkDocument(document);
    const { cursor, limit } = parseBookmarkQuery(c.req.query());
    const file = await clippings.resolve(document, auth);
    if (file && cursor === 0) await flush(auth, document, file);
    const page = await bookmarks.page(document, file, cursor, limit);
    log.info('bookmarks pulled', {
      document,
      bookFileId: file?.bookFileId ?? null,
      cursor,
      next: page.cursor,
      more: page.more,
      items: page.items.map((item) => `${(item as { id: string }).id}${(item as { deleted: number }).deleted ? ':deleted' : ''}`),
    });
    lastSync.setToCurrentTime({ kind: 'bookmarks' });
    return c.json(page);
  });

  app.put('/api/v1/bookmarks/:document', async (c) => {
    const auth = deviceAuth(c);
    if (!auth) return unauthorized(c);
    const document = c.req.param('document');
    checkDocument(document);
    const items = decodeBookmarkBatch(await c.req.json().catch(() => null));
    const file = await clippings.resolve(document, auth);
    if (!file) {
      await pending.put(auth.user, document, 'bookmark', items);
      log.info('bookmarks kept for unmatched book', { document, items: items.map((item) => `${item.id}${item.deleted ? ':deleted' : ''}`) });
      return c.json({ accepted: items.length });
    }
    await flush(auth, document, file);
    await bookmarks.apply(file, items);
    log.info('bookmarks pushed', {
      document,
      bookFileId: file.bookFileId,
      items: items.map((item) => `${item.id}${item.deleted ? ':deleted' : ''}`),
    });
    return c.json({ accepted: items.length });
  });

  app.put('/api/v1/stats/sessions', async (c) => {
    const auth = deviceAuth(c);
    if (!auth) return unauthorized(c);
    const batch = decodeSessionBatch(await c.req.json().catch(() => null));
    const accepted = await sessions.upload(auth, batch);
    log.info('reading sessions received', { deviceId: batch.device_id ?? null, sessions: accepted });
    lastSync.setToCurrentTime({ kind: 'sessions' });
    return c.json({ accepted_session_ids: accepted });
  });

  return app;
}
