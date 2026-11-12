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
