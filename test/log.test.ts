import { describe, expect, it } from 'vitest';

import { createLogger } from '../src/log.js';

const sink = () => {
  const chunks: string[] = [];
  return { chunks, write: (line: string) => chunks.push(line) > 0 } as unknown as NodeJS.WritableStream & { chunks: string[] };
};
const lines = (s: { chunks: string[] }) => s.chunks.splice(0).map((l) => JSON.parse(l));

describe('log', () => {
  it('writes one JSON line per event with ISO time, label level and top-level fields', () => {
    const out = sink();
    const err = sink();
    const log = createLogger('info', out, err);
    log.debug('hidden');
    log.info('hello', { port: 1 });
    log.warn('careful', { id: 'x' });
    log.error('boom');
    const [info] = lines(out);
    expect(Object.keys(info).sort()).toEqual(['level', 'msg', 'port', 'time']);
    expect(info).toMatchObject({ level: 'info', msg: 'hello', port: 1 });
    expect(new Date(info.time).toISOString()).toBe(info.time);
    expect(lines(out)).toEqual([]);
    expect(lines(err).map((l) => [l.level, l.msg])).toEqual([['warn', 'careful'], ['error', 'boom']]);
  });
});
