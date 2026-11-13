import { z } from 'zod';

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;

const required = (name: string) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      const value = v?.trim();
      if (!value) {
        ctx.addIssue({ code: 'custom', message: `${name} is required` });
        return z.NEVER;
      }
      return value;
    });

const port = (name: string, fallback: number, min: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      const raw = v?.trim() || String(fallback);
      const value = Number(raw);
      if (!/^\d+$/.test(raw) || value < min || value > 65535) {
        ctx.addIssue({ code: 'custom', message: `${name} must be an integer between ${min} and 65535` });
        return z.NEVER;
      }
      return value;
    });

const schema = z.object({
  PORT: port('PORT', 8080, 1),
  METRICS_PORT: port('METRICS_PORT', 9090, 0).transform((v) => (v === 0 ? null : v)),
  DATABASE_URL: required('DATABASE_URL'),
  BOOKORBIT_URL: required('BOOKORBIT_URL')
    .pipe(z.url({ protocol: /^https?$/, error: 'BOOKORBIT_URL must be a valid http(s) URL' }))
    .transform((v) => v.replace(/\/+$/, '')),
  BOOKORBIT_API_KEY: required('BOOKORBIT_API_KEY'),
  LOG_LEVEL: z
    .string()
    .default('info')
    .transform((v) => v.toLowerCase())
    .pipe(z.enum(LEVELS, { error: `LOG_LEVEL must be one of ${LEVELS.join(', ')}` })),
});

export interface Config {
  port: number;
  metricsPort: number | null;
  databaseUrl: string;
  bookorbitUrl: string;
  bookorbitApiKey: string;
  logLevel: (typeof LEVELS)[number];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) throw new Error(result.error.issues[0]!.message);
  const e = result.data;
  return {
    port: e.PORT,
    metricsPort: e.METRICS_PORT,
    databaseUrl: e.DATABASE_URL,
    bookorbitUrl: e.BOOKORBIT_URL,
    bookorbitApiKey: e.BOOKORBIT_API_KEY,
    logLevel: e.LOG_LEVEL,
  };
}
