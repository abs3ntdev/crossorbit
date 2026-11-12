import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { BookOrbit } from './bookorbit.js';
import { loadConfig } from './config.js';
import { connect, migrate } from './db.js';
import { createLogger } from './log.js';

const config = loadConfig();
const log = createLogger(config.logLevel);
const sql = connect(config.databaseUrl);
await migrate(sql);

const app = createApp(sql, new BookOrbit(config.bookorbitUrl, config.bookorbitApiKey), log);
const server = serve({ fetch: app.fetch, port: config.port }, ({ port }) => log.info('listening', { port }));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close();
    void sql.end({ timeout: 5 }).then(() => process.exit(0));
  });
}
