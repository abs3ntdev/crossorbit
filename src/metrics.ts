import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';

import type { Sql } from './db.js';

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'crossorbit_' });

export const httpRequests = new Counter({
  name: 'crossorbit_http_requests_total',
  help: 'Device requests by route and status',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const httpDuration = new Histogram({
  name: 'crossorbit_http_request_duration_seconds',
  help: 'Device request latency',
  labelNames: ['method', 'route'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const upstreamRequests = new Counter({
  name: 'crossorbit_bookorbit_requests_total',
  help: 'Requests to BookOrbit by operation and status',
  labelNames: ['operation', 'status'] as const,
  registers: [registry],
});

export const upstreamDuration = new Histogram({
  name: 'crossorbit_bookorbit_request_duration_seconds',
  help: 'BookOrbit request latency',
  labelNames: ['operation'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const progressSyncs = new Counter({
  name: 'crossorbit_progress_syncs_total',
  help: 'Progress pushes and pulls by outcome',
  labelNames: ['direction', 'status'] as const,
  registers: [registry],
});

export const clippingsTransferred = new Counter({
  name: 'crossorbit_clippings_total',
  help: 'Clippings moved between the device and BookOrbit',
  labelNames: ['direction', 'kind'] as const,
  registers: [registry],
});

export const clippingsUnanchored = new Counter({
  name: 'crossorbit_clippings_unanchored_total',
  help: 'Clippings or annotations that could not be placed in the EPUB',
  labelNames: ['direction'] as const,
  registers: [registry],
});

export const epubLoads = new Counter({
  name: 'crossorbit_epub_loads_total',
  help: 'EPUB downloads from BookOrbit by outcome',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

export const lastSync = new Gauge({
  name: 'crossorbit_last_sync_timestamp_seconds',
  help: 'Unix time of the last successful device sync',
  labelNames: ['kind'] as const,
  registers: [registry],
});

export const up = new Gauge({
  name: 'crossorbit_dependency_up',
  help: 'Whether a dependency answered the last scrape (1) or not (0)',
  labelNames: ['dependency'] as const,
  registers: [registry],
});

export function trackStorage(sql: Sql) {
  new Gauge({
    name: 'crossorbit_clippings_stored',
    help: 'Clippings held in the database',
    labelNames: ['state'] as const,
    registers: [registry],
    async collect() {
      this.reset();
      const rows = await sql<{ deleted: boolean; anchored: boolean; n: string }[]>`
        SELECT deleted, annotation_id IS NOT NULL AS anchored, count(*) AS n FROM clippings GROUP BY 1, 2`;
      for (const row of rows) {
        this.set({ state: row.deleted ? 'deleted' : row.anchored ? 'live' : 'unanchored' }, Number(row.n));
      }
    },
  });
  new Gauge({
    name: 'crossorbit_documents',
    help: 'Document hashes resolved to BookOrbit books',
    registers: [registry],
    async collect() {
      const [row] = await sql<{ n: string }[]>`SELECT count(*) AS n FROM documents`;
      this.set(Number(row.n));
    },
  });
}

export function operationOf(path: string): string {
  if (path.startsWith('/api/v1/koreader/plugin/match-check')) return 'match_check';
  if (path.startsWith('/api/v1/koreader/users/auth')) return 'device_auth';
  if (path.startsWith('/api/v1/koreader/syncs/progress/')) return 'progress_pull';
  if (path.startsWith('/api/v1/koreader/syncs/progress')) return 'progress_push';
  if (/\/books\/\d+\/annotations\/\d+/.test(path)) return 'annotation_item';
  if (/\/books\/\d+\/annotations/.test(path)) return 'annotations';
  if (path.includes('/serve')) return 'epub_download';
  return 'other';
}
