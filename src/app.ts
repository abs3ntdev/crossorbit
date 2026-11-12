import { Hono, type Context } from 'hono';
import { sql } from 'kysely';

import { BookOrbit, BookOrbitError, type DeviceAuth } from './bookorbit.js';
import { ClippingService } from './clippings.js';
import { type Db, now } from './db.js';
import type { Logger } from './log.js';
import { httpDuration, httpRequests, lastSync, progressSyncs } from './metrics.js';
import { decodeBatch, parsePageQuery, ProtocolError } from './protocol.js';

const DOCUMENT_RE = /^[A-Za-z0-9._-]{1,64}$/;
const XPATH_MAX = 120;

function deviceAuth(c: Context): DeviceAuth | null {
  const user = c.req.header('x-auth-user');
  const key = c.req.header('x-auth-key');
  return user && key ? { user, key } : null;
}

function unauthorized(c: Context) {
  return c.json({ code: 2001, message: 'Unauthorized' }, 401);
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
  if (!body.progress && typeof position?.xpath === 'string' && position.xpath.length <= XPATH_MAX) body.progress = position.xpath;
  return body;
}

function isPosition(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function samePercentage(a: unknown, b: number) {
  return typeof a === 'number' && Math.abs(a - b) < 1e-6;
}

export function createApp(db: Db, bookorbit: BookOrbit, log: Logger) {
  const app = new Hono();
  const clippings = new ClippingService(db, bookorbit, log);

  app.use('*', async (c, next) => {
    if (c.req.path === '/healthz') return next();
    const started = performance.now();
    await next();
    const route = c.req.routePath === '/*' ? 'unmatched' : c.req.routePath;
    httpRequests.inc({ method: c.req.method, route, status: String(c.res.status) });
    httpDuration.observe({ method: c.req.method, route }, (performance.now() - started) / 1000);
  });

  app.onError((error, c) => {
    if (error instanceof ProtocolError) return c.json({ code: 2003, message: error.message }, 400);
    if (error instanceof BookOrbitError && error.status === 401) return unauthorized(c);
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
    const res = await bookorbit.device('/syncs/progress', auth, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    log.info('progress pushed', { document: body.document, percentage: body.percentage, status: res.status });
    progressSyncs.inc({ direction: 'push', status: String(res.status) });
    if (res.ok) {
      lastSync.setToCurrentTime({ kind: 'progress' });
      const position = (raw as { position?: unknown }).position;
      const { document, progress, percentage } = body;
      if (isPosition(position) && typeof document === 'string' && typeof percentage === 'number') {
        const row = { progress: String(progress ?? ''), percentage, position };
        await db.insertInto('positions').values({ username: auth.user, document, ...row })
          .onConflict((oc) => oc.columns(['username', 'document']).doUpdateSet({ ...row, updated_at: now(db) }))
          .execute();
      }
    }
    return relay(c, res);
  });

  app.get('/syncs/progress/:document', async (c) => {
    const auth = deviceAuth(c);
    if (!auth) return unauthorized(c);
    const document = c.req.param('document');
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
    if (!DOCUMENT_RE.test(document)) throw new ProtocolError('Invalid document');
    const { cursor, limit } = parsePageQuery(c.req.query());
    const file = await clippings.resolve(document, auth);
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
    if (!DOCUMENT_RE.test(document)) throw new ProtocolError('Invalid document');
    const items = decodeBatch(await c.req.json().catch(() => null));
    const file = await clippings.resolve(document, auth);
    if (!file) return c.json({ code: 2004, message: 'Book not found for the given document hash' }, 404);
    await clippings.apply(file, items);
    log.info('clippings pushed', {
      document,
      bookFileId: file.bookFileId,
      items: items.map((item) => `${item.id}${item.deleted ? ':deleted' : ''}`),
    });
    return c.json({ until: Math.floor(Date.now() / 1000), accepted: items.length });
  });

  return app;
}
