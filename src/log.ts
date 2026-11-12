import { pino } from 'pino';

import type { Config } from './config.js';

type Level = Config['logLevel'];

export type Logger = Record<Level, (msg: string, fields?: Record<string, unknown>) => void>;

export function createLogger(level: Level, stdout: NodeJS.WritableStream = process.stdout, stderr: NodeJS.WritableStream = process.stderr): Logger {
  const logger = pino(
    {
      level,
      base: undefined,
      messageKey: 'msg',
      timestamp: () => `,"time":"${new Date().toISOString()}"`,
      formatters: { level: (label) => ({ level: label }) },
    },
    pino.multistream(
      [
        { level: 'debug', stream: stdout },
        { level: 'warn', stream: stderr },
      ],
      { dedupe: true },
    ),
  );
  const emit = (at: Level) => (msg: string, fields?: Record<string, unknown>) => logger[at](fields ?? {}, msg);
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}
