export const SYNC_VERSION = 2;
export const TEXT_MAX_BYTES = 4096;
export const BATCH_MAX = 50;
export const PAGE_MAX = 100;
export const DEFAULT_PAGE = 50;
export const CHAPTER_MAX = 64;

const U16 = 0xffff;
const U32 = 0xffffffff;
const ID_RE = /^[\x21-\x7e]{1,64}$/;

export interface ClippingRow {
  clipping_id: string;
  revision: string | number;
  deleted: boolean;
  spine: number;
  start_page: number;
  end_page: number;
  pages: number;
  start_word: number;
  end_word: number;
  words: number;
  para: number | null;
  chapter: string;
  text: string;
  created_at: string | number;
  layout_signature: string | number;
  start_offset: string | number | null;
  end_offset: string | number | null;
}

export interface LiveItem {
  id: string;
  deleted: false;
  spine: number;
  start_page: number;
  end_page: number;
  pages: number;
  start_word: number;
  end_word: number;
  words: number;
  para: number | null;
  chapter: string;
  text: string;
  created_at: number;
  layout_signature: number;
  start_offset: number | null;
  end_offset: number | null;
}

export type IncomingItem = { id: string; deleted: true } | LiveItem;

export function encodeItem(row: ClippingRow): Record<string, unknown> {
  const revision = Number(row.revision);
  if (row.deleted) return { id: row.clipping_id, revision, deleted: 1 };
  return {
    id: row.clipping_id,
    revision,
    deleted: 0,
    spine: row.spine,
    start_page: row.start_page,
    end_page: row.end_page,
    pages: row.pages,
    start_word: row.start_word,
    end_word: row.end_word,
    words: row.words,
    ...(row.para != null ? { para: row.para } : {}),
    chapter: row.chapter,
    text: row.text,
    created_at: Number(row.created_at),
    layout_signature: Number(row.layout_signature),
    ...(row.start_offset != null && row.end_offset != null
      ? { start_offset: Number(row.start_offset), end_offset: Number(row.end_offset) }
      : {}),
  };
}

export class ProtocolError extends Error {}

function uint(o: Record<string, unknown>, key: string, max: number, fallback?: number): number {
  const v = o[key];
  if (v == null && fallback !== undefined) return fallback;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max) throw new ProtocolError(`Invalid ${key}`);
  return v;
}

function optionalUint(o: Record<string, unknown>, key: string, max: number): number | null {
  return o[key] == null ? null : uint(o, key, max);
}

export function decodeItem(raw: unknown): IncomingItem {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ProtocolError('Invalid item');
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !ID_RE.test(o.id)) throw new ProtocolError('Invalid id');
  const deleted = uint(o, 'deleted', 1, 0);
  if (deleted === 1) return { id: o.id, deleted: true };
  if (typeof o.text !== 'string' || o.text.length === 0 || Buffer.byteLength(o.text) > TEXT_MAX_BYTES) {
    throw new ProtocolError('Invalid text');
  }
  if (o.chapter != null && typeof o.chapter !== 'string') throw new ProtocolError('Invalid chapter');
  const start_offset = optionalUint(o, 'start_offset', U32 - 1);
  const end_offset = optionalUint(o, 'end_offset', U32 - 1);
  if ((start_offset == null) !== (end_offset == null)) throw new ProtocolError('Incomplete offsets');
  if (start_offset != null && end_offset != null && end_offset <= start_offset) throw new ProtocolError('Offsets out of order');
  return {
    id: o.id,
    deleted: false,
    spine: uint(o, 'spine', U16),
    start_page: uint(o, 'start_page', U16, 0),
    end_page: uint(o, 'end_page', U16, 0),
    pages: uint(o, 'pages', U16, 1),
    start_word: uint(o, 'start_word', U16, 0),
    end_word: uint(o, 'end_word', U16, 0),
    words: uint(o, 'words', U16, 0),
    para: optionalUint(o, 'para', U16 - 1),
    chapter: truncateUtf8(((o.chapter as string | undefined) ?? '').slice(0, CHAPTER_MAX), CHAPTER_MAX),
    text: o.text,
    created_at: uint(o, 'created_at', U32, 0),
    layout_signature: uint(o, 'layout_signature', U32, 0),
    start_offset,
    end_offset,
  };
}

export function decodeBatch(body: unknown): IncomingItem[] {
  const items = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(items) || items.length > BATCH_MAX) throw new ProtocolError('Invalid items');
  return items.map(decodeItem);
}

export interface PageQuery {
  cursor: number;
  limit: number;
}

export function parsePageQuery(query: Record<string, string | undefined>): PageQuery {
  const cursor = Number(query.cursor ?? 0);
  const limit = Number(query.limit ?? DEFAULT_PAGE);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new ProtocolError('Invalid cursor');
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX) throw new ProtocolError('Invalid limit');
  return { cursor, limit };
}

export function truncateUtf8(value: string, maxBytes: number): string {
  let out = '';
  for (const ch of value) {
    if (Buffer.byteLength(out + ch) > maxBytes) break;
    out += ch;
  }
  return out;
}
