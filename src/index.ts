import { serve } from '@hono/node-server';
import { Hono } from 'hono';

import { sql } from 'kysely';

import { createApp } from './app.js';
import { BookOrbit } from './bookorbit.js';
import { loadConfig } from './config.js';
import { connect, migrate } from './db.js';
import { createLogger } from './log.js';
import { registry, trackStorage, up } from './metrics.js';

const config = loadConfig();
const log = createLogger(config.logLevel);
const db = connect(config.databaseUrl);
await migrate(db);

const bookorbit = new BookOrbit(config.bookorbitUrl, config.bookorbitApiKey);
const app = createApp(db, bookorbit, log);
const servers = [serve({ fetch: app.fetch, port: config.port }, ({ port }) => log.info('listening', { port }))];

if (config.metricsPort != null) {
  trackStorage(db);
  const metrics = new Hono();
  metrics.get('/metrics', async (c) => {
    const [database, api] = await Promise.all([
      sql`SELECT 1`.execute(db).then(() => 1, () => 0),
      bookorbit.ping().then((ok) => (ok ? 1 : 0)),
    ]);
    up.set({ dependency: 'database' }, database);
    up.set({ dependency: 'bookorbit' }, api);
    return c.text(await registry.metrics(), 200, { 'content-type': registry.contentType });
  });
  servers.push(serve({ fetch: metrics.fetch, port: config.metricsPort }, ({ port }) => log.info('metrics listening', { port })));
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    log.info('shutting down', { signal });
    setTimeout(() => {
      log.warn('shutdown timed out');
      process.exit(1);
    }, 10_000).unref();
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    await db.destroy();
    process.exit(0);
  });
}
