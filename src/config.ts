export interface Config {
  port: number;
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
    databaseUrl: required('DATABASE_URL'),
    bookorbitUrl: required('BOOKORBIT_URL').replace(/\/+$/, ''),
    bookorbitApiKey: required('BOOKORBIT_API_KEY'),
    logLevel: level as Config['logLevel'],
  };
}
