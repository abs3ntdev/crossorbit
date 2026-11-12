import type { Config } from './config.js';

const ORDER = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof ORDER;

export type Logger = Record<Level, (msg: string, fields?: Record<string, unknown>) => void>;

export function createLogger(level: Config['logLevel']): Logger {
  const emit = (at: Level) => (msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[at] < ORDER[level]) return;
    const line = JSON.stringify({ time: new Date().toISOString(), level: at, msg, ...fields });
    (at === 'error' || at === 'warn' ? process.stderr : process.stdout).write(line + '\n');
  };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}
