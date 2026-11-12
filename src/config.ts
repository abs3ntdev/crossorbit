export interface Config {
  port: number;
  metricsPort: number | null;
  databaseUrl: string;
  bookorbitUrl: string;
  bookorbitApiKey: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const level = (env.LOG_LEVEL ?? 'info').toLowerCase();
  if (!(LEVELS as readonly string[]).includes(level)) throw new Error(`LOG_LEVEL must be one of ${LEVELS.join(', ')}`);
  return {
    port: Number(env.PORT ?? 8080),
    metricsPort: env.METRICS_PORT === '0' ? null : Number(env.METRICS_PORT ?? 9090),
    databaseUrl: required('DATABASE_URL'),
    bookorbitUrl: required('BOOKORBIT_URL').replace(/\/+$/, ''),
    bookorbitApiKey: required('BOOKORBIT_API_KEY'),
    logLevel: level as Config['logLevel'],
  };
}
