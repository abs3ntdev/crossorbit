import { z } from 'zod';

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

const uint = (max: number) => z.number().int().min(0).max(max);
const withDefault = (max: number, fallback: number) => uint(max).nullish().transform((v) => v ?? fallback);
const optional = (max: number) => uint(max).nullish().transform((v) => v ?? null);

const itemBase = z.looseObject({ id: z.string().regex(ID_RE), deleted: withDefault(1, 0) });

const liveItem = z
  .looseObject({
    text: z.string().min(1).refine((t) => Buffer.byteLength(t) <= TEXT_MAX_BYTES),
    chapter: z.string().nullish(),
    start_offset: optional(U32 - 1),
    end_offset: optional(U32 - 1),
  })
  .refine((o) => (o.start_offset == null) === (o.end_offset == null), { message: 'Incomplete offsets', path: [] })
  .refine((o) => o.start_offset == null || o.end_offset! > o.start_offset, { message: 'Offsets out of order', path: [] });

const liveFields = z.looseObject({
  spine: uint(U16),
  start_page: withDefault(U16, 0),
  end_page: withDefault(U16, 0),
  pages: withDefault(U16, 1),
  start_word: withDefault(U16, 0),
  end_word: withDefault(U16, 0),
  words: withDefault(U16, 0),
  para: optional(U16 - 1),
  created_at: withDefault(U32, 0),
  layout_signature: withDefault(U32, 0),
});

const batch = z.object({ items: z.array(z.unknown()).max(BATCH_MAX) }, { error: 'Invalid items' });

const pageQuery = z.object({
  cursor: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(PAGE_MAX).default(DEFAULT_PAGE),
});

function parse<T extends z.ZodType>(schema: T, value: unknown, fallback: string): z.output<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0]!;
  const key = issue.path[0];
  throw new ProtocolError(key == null ? (issue.code === 'custom' ? issue.message : fallback) : `Invalid ${String(key)}`);
}

export function decodeItem(raw: unknown): IncomingItem {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ProtocolError('Invalid item');
  const { id, deleted } = parse(itemBase, raw, 'Invalid item');
  if (deleted === 1) return { id, deleted: true };
  const o = { ...parse(liveItem, raw, 'Invalid item'), ...parse(liveFields, raw, 'Invalid item') };
  return {
    id,
    deleted: false,
    spine: o.spine,
    start_page: o.start_page,
    end_page: o.end_page,
    pages: o.pages,
    start_word: o.start_word,
    end_word: o.end_word,
    words: o.words,
    para: o.para,
    chapter: truncateUtf8((o.chapter ?? '').slice(0, CHAPTER_MAX), CHAPTER_MAX),
    text: o.text,
    created_at: o.created_at,
    layout_signature: o.layout_signature,
    start_offset: o.start_offset,
    end_offset: o.end_offset,
  };
}

export function decodeBatch(body: unknown): IncomingItem[] {
  return parse(batch, body, 'Invalid items').items.map(decodeItem);
}

export type PageQuery = z.output<typeof pageQuery>;

export function parsePageQuery(query: Record<string, string | undefined>): PageQuery {
  return parse(pageQuery, query, 'Invalid query');
}

export function truncateUtf8(value: string, maxBytes: number): string {
  let out = '';
  for (const ch of value) {
    if (Buffer.byteLength(out + ch) > maxBytes) break;
    out += ch;
  }
  return out;
}
