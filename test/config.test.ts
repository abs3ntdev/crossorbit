import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

const base = { DATABASE_URL: 'postgres://x', BOOKORBIT_URL: 'http://b//', BOOKORBIT_API_KEY: 'k' };

describe('config', () => {
  it('applies defaults', () => {
    expect(loadConfig(base)).toEqual({
      port: 8080, metricsPort: 9090, databaseUrl: 'postgres://x', bookorbitUrl: 'http://b', bookorbitApiKey: 'k', logLevel: 'info',
    });
  });

  it('parses overrides', () => {
    expect(loadConfig({ ...base, PORT: '1', METRICS_PORT: '0', LOG_LEVEL: 'WARN' })).toMatchObject({ port: 1, metricsPort: null, logLevel: 'warn' });
  });

  it('rejects missing or invalid values', () => {
    expect(() => loadConfig({ ...base, DATABASE_URL: '  ' })).toThrow('DATABASE_URL is required');
    expect(() => loadConfig({ ...base, BOOKORBIT_API_KEY: undefined })).toThrow('BOOKORBIT_API_KEY is required');
    expect(() => loadConfig({ ...base, LOG_LEVEL: 'trace' })).toThrow('LOG_LEVEL must be one of debug, info, warn, error');
  });
});
