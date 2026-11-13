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
    for (const PORT of ['abc', '1.5', '0', '65536', '-1']) expect(() => loadConfig({ ...base, PORT })).toThrow('PORT must be an integer between 1 and 65535');
    for (const METRICS_PORT of ['x', '70000']) expect(() => loadConfig({ ...base, METRICS_PORT })).toThrow('METRICS_PORT must be an integer between 0 and 65535');
    for (const BOOKORBIT_URL of ['not a url', 'ftp://b']) expect(() => loadConfig({ ...base, BOOKORBIT_URL })).toThrow('BOOKORBIT_URL must be a valid http(s) URL');
  });
});
