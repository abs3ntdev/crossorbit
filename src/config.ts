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

const schema = z.object({
  PORT: z.string().optional().transform((v) => Number(v ?? 8080)),
  METRICS_PORT: z.string().optional().transform((v) => (v === '0' ? null : Number(v ?? 9090))),
  DATABASE_URL: required('DATABASE_URL'),
  BOOKORBIT_URL: required('BOOKORBIT_URL').transform((v) => v.replace(/\/+$/, '')),
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
