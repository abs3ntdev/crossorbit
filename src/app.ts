import { Hono, type Context } from 'hono';

import { BookOrbit, BookOrbitError, type DeviceAuth } from './bookorbit.js';
import { ClippingService } from './clippings.js';
import type { Sql } from './db.js';
import type { Logger } from './log.js';
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

export function createApp(sql: Sql, bookorbit: BookOrbit, log: Logger) {
  const app = new Hono();
  const clippings = new ClippingService(sql, bookorbit, log);

  app.onError((error, c) => {
    if (error instanceof ProtocolError) return c.json({ code: 2003, message: error.message }, 400);
    if (error instanceof BookOrbitError && error.status === 401) return unauthorized(c);
    log.error('request failed', { path: c.req.path, error: error.message });
    return c.json({ code: 2000, message: 'Upstream error' }, 502);
  });

  app.get('/healthz', async (c) => {
    await sql`SELECT 1`;
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
    const body = progressBody(await c.req.json().catch(() => ({})));
    return relay(
      c,
      await bookorbit.device('/syncs/progress', auth, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  });

  app.get('/syncs/progress/:document', async (c) => {
    const auth = deviceAuth(c);
    if (!auth) return unauthorized(c);
    return relay(c, await bookorbit.device(`/syncs/progress/${encodeURIComponent(c.req.param('document'))}`, auth));
  });

  app.get('/api/v1/clippings/:document', async (c) => {
    const auth = deviceAuth(c);
    if (!auth) return unauthorized(c);
    const document = c.req.param('document');
    if (!DOCUMENT_RE.test(document)) throw new ProtocolError('Invalid document');
    const { cursor, limit } = parsePageQuery(c.req.query());
    const file = await clippings.resolve(document, auth);
    return c.json(await clippings.page(document, file, cursor, limit));
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
    return c.json({ until: Math.floor(Date.now() / 1000), accepted: items.length });
  });

  return app;
}
