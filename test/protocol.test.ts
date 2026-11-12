import { describe, expect, it } from 'vitest';

import { progressBody } from '../src/app.js';
import { type ClippingRow, decodeBatch, decodeItem, encodeItem, parsePageQuery, ProtocolError } from '../src/protocol.js';

const row: ClippingRow = {
  clipping_id: 'abc123',
  revision: '7',
  deleted: false,
  spine: 2,
  start_page: 1,
  end_page: 2,
  pages: 10,
  start_word: 3,
  end_word: 4,
  words: 5,
  para: null,
  chapter: 'Ch',
  text: 'quote',
  created_at: '1700000000',
  layout_signature: '4294967295',
  start_offset: null,
  end_offset: null,
};

describe('encode', () => {
  it('emits the firmware item shape with numeric fields', () => {
    expect(encodeItem(row)).toEqual({
      id: 'abc123', revision: 7, deleted: 0, spine: 2, start_page: 1, end_page: 2, pages: 10, start_word: 3, end_word: 4,
      words: 5, chapter: 'Ch', text: 'quote', created_at: 1700000000, layout_signature: 4294967295,
    });
  });

  it('includes para and offsets only when present', () => {
    expect(encodeItem({ ...row, para: 3, start_offset: '5', end_offset: 9 })).toMatchObject({ para: 3, start_offset: 5, end_offset: 9 });
  });

  it('emits bare tombstones', () => {
    expect(encodeItem({ ...row, deleted: true })).toEqual({ id: 'abc123', revision: 7, deleted: 1 });
  });
});

describe('decode', () => {
  const live = { id: 'a1', spine: 0, start_page: 0, end_page: 0, pages: 1, start_word: 0, end_word: 1, words: 2, chapter: 'c', text: 't', created_at: 1, layout_signature: 9 };

  it('round-trips with encode', () => {
    const item = decodeItem({ ...live, para: 4, start_offset: 1, end_offset: 3 });
    expect(item).toMatchObject({ ...live, deleted: false, para: 4, start_offset: 1, end_offset: 3 });
  });

  it('decodes deletions', () => {
    expect(decodeItem({ id: 'a1', deleted: 1 })).toEqual({ id: 'a1', deleted: true });
  });

  it.each([
    [{ ...live, id: 'has space' }],
    [{ ...live, id: 'x'.repeat(65) }],
    [{ ...live, text: '' }],
    [{ ...live, text: 'x'.repeat(4097) }],
    [{ ...live, spine: 70000 }],
    [{ ...live, start_offset: 3 }],
    [{ ...live, start_offset: 3, end_offset: 3 }],
    [{ ...live, deleted: 2 }],
  ])('rejects %j', (item) => {
    expect(() => decodeItem(item)).toThrow(ProtocolError);
  });

  it('truncates chapter titles on a UTF-8 boundary', () => {
    const item = decodeItem({ ...live, chapter: 'é'.repeat(40) });
    expect(item.deleted === false && Buffer.byteLength(item.chapter)).toBe(64);
  });

  it('bounds batches', () => {
    expect(() => decodeBatch({ items: Array(51).fill({ id: 'a', deleted: 1 }) })).toThrow(ProtocolError);
    expect(() => decodeBatch({})).toThrow(ProtocolError);
  });

  it('parses page queries', () => {
    expect(parsePageQuery({ cursor: '0', limit: '1', format: 'reader' })).toEqual({ cursor: 0, limit: 1 });
    expect(() => parsePageQuery({ cursor: '-1' })).toThrow(ProtocolError);
    expect(() => parsePageQuery({ limit: '101' })).toThrow(ProtocolError);
  });
});

describe('progress body', () => {
  it('strips position and keeps metadata', () => {
    expect(progressBody({ document: 'd', progress: 'x', percentage: 0.5, position: { xpath: '/y' }, metadata: { title: 'T' } })).toEqual({
      document: 'd', progress: 'x', percentage: 0.5, metadata: { title: 'T' },
    });
  });

  it('uses position.xpath when progress is empty', () => {
    expect(progressBody({ document: 'd', progress: '', percentage: 0.1, position: { xpath: '/body/p[2]' } }).progress).toBe('/body/p[2]');
  });
});

describe('validation edge cases', () => {
  const live = { id: 'a1', spine: 0, text: 't' };

  it.each([
    [null, 'Invalid item'],
    [[], 'Invalid item'],
    [{ ...live, id: 5 }, 'Invalid id'],
    [{ ...live, text: 'é'.repeat(2049) }, 'Invalid text'],
    [{ ...live, chapter: 3 }, 'Invalid chapter'],
    [{ ...live, spine: 1.5 }, 'Invalid spine'],
    [{ ...live, spine: undefined }, 'Invalid spine'],
    [{ ...live, para: 0xffff }, 'Invalid para'],
    [{ ...live, created_at: 0x100000000 }, 'Invalid created_at'],
    [{ ...live, start_offset: 0xffffffff, end_offset: 1 }, 'Invalid start_offset'],
    [{ ...live, end_offset: 3 }, 'Incomplete offsets'],
    [{ ...live, start_offset: 4, end_offset: 3 }, 'Offsets out of order'],
  ])('rejects %j with message', (item, message) => {
    expect(() => decodeItem(item)).toThrow(new ProtocolError(message));
  });

  it('accepts boundary values and applies defaults', () => {
    expect(decodeItem({ ...live, text: 'é'.repeat(2048), spine: 0xffff, para: 0xfffe, layout_signature: 0xffffffff, start_offset: 0, end_offset: 0xfffffffe, chapter: null }))
      .toEqual({
        id: 'a1', deleted: false, spine: 0xffff, start_page: 0, end_page: 0, pages: 1, start_word: 0, end_word: 0, words: 0,
        para: 0xfffe, chapter: '', text: 'é'.repeat(2048), created_at: 0, layout_signature: 0xffffffff, start_offset: 0, end_offset: 0xfffffffe,
      });
    expect(decodeItem({ id: '~'.repeat(64), deleted: 1, text: 5 })).toEqual({ id: '~'.repeat(64), deleted: true });
  });

  it('validates batches', () => {
    expect(decodeBatch({ items: Array(50).fill({ id: 'a', deleted: 1 }) })).toHaveLength(50);
    expect(() => decodeBatch(null)).toThrow(new ProtocolError('Invalid items'));
    expect(() => decodeBatch({ items: {} })).toThrow(new ProtocolError('Invalid items'));
  });

  it('parses page query edges', () => {
    expect(parsePageQuery({})).toEqual({ cursor: 0, limit: 50 });
    expect(parsePageQuery({ cursor: String(Number.MAX_SAFE_INTEGER), limit: '100' })).toEqual({ cursor: Number.MAX_SAFE_INTEGER, limit: 100 });
    expect(() => parsePageQuery({ cursor: 'x' })).toThrow(new ProtocolError('Invalid cursor'));
    expect(() => parsePageQuery({ cursor: '1.5' })).toThrow(new ProtocolError('Invalid cursor'));
    expect(() => parsePageQuery({ cursor: String(2 ** 53) })).toThrow(new ProtocolError('Invalid cursor'));
    expect(() => parsePageQuery({ limit: '0' })).toThrow(new ProtocolError('Invalid limit'));
  });
});
