import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { BookOrbit, DeviceAuth } from './bookorbit.js';
import { type ClippingService, refusal, type ResolvedFile } from './clippings.js';
import { type Db, nextRevision } from './db.js';
import { parseXPointer } from './epub/xpointer.js';
import {
  type AckDeleted, BOOKMARK_MAX_KEYS, type BookmarkAckApplied, type BookmarkAddEntry, EXCHANGE_MAX_CHANGES, type ExchangeKey, type KoBookmark,
  koDatetime, type KoDeleteEntry, koKey, MAX_ROUNDS,
} from './exchange.js';
import type { Logger } from './log.js';
import { bookmarksTransferred, bookmarksUnanchored } from './metrics.js';
import { PAGE_MAX, ProtocolError, SYNC_VERSION, truncateUtf8 } from './protocol.js';

export const XPATH_MAX = 512;
export const NAME_MAX = 128;
export const SUMMARY_MAX = 72;
export const TITLE_MAX = 500;
export const BOOKMARK_BATCH_MAX = 50;

const U16 = 0xffff;
const U32 = 0xffffffff;

/** Matches the device: first 8 bytes of sha256(xpath) as lowercase hex. */
export function bookmarkIdFor(xpath: string): string {
  return createHash('sha256').update(xpath).digest('hex').slice(0, 16);
}

export interface BookmarkRow {
  bookmark_id: string;
  revision: string | number;
  deleted: boolean | number;
  xpath: string;
  percentage: number;
  summary: string;
  si: number;
  pc: number;
  pp: number;
  name: string;
  vo: string | number | null;
}

export interface LiveBookmark {
  id: string;
  deleted: false;
  xpath: string;
  percentage: number;
  summary: string;
  si: number;
  pc: number;
  pp: number;
  name: string;
  vo: number | null;
}

export type IncomingBookmark = { id: string; deleted: true } | LiveBookmark;

export function encodeBookmark(row: BookmarkRow): Record<string, unknown> {
  if (row.deleted) return { id: row.bookmark_id, deleted: 1 };
  return {
    id: row.bookmark_id,
    deleted: 0,
    xpath: row.xpath,
    percentage: row.percentage,
    summary: row.summary,
    si: row.si,
    pc: row.pc,
    pp: row.pp,
    name: row.name,
    ...(row.vo != null ? { vo: Number(row.vo) } : {}),
  };
}

const uint = (max: number) => z.number().int().min(0).max(max);
const ID = z.string().regex(/^[0-9a-f]{16}$/);
const deletedItem = z.looseObject({ id: ID, deleted: z.literal(1) });
const liveItem = z.looseObject({
  id: ID,
  deleted: z.literal(0).nullish(),
  xpath: z.string().min(1).max(XPATH_MAX),
  percentage: z.number().min(0).max(1),
  summary: z.string().nullish(),
  si: uint(U16).nullish(),
  pc: uint(U16).nullish(),
  pp: uint(U16).nullish(),
  name: z.string().max(NAME_MAX).nullish(),
  vo: uint(U32).nullish(),
});
const batch = z.object({ items: z.array(z.unknown()).max(BOOKMARK_BATCH_MAX) });

export function decodeBookmarkBatch(body: unknown): IncomingBookmark[] {
  const parsed = batch.safeParse(body);
  if (!parsed.success) throw new ProtocolError('Invalid items');
  return parsed.data.items.map((raw) => {
    const del = deletedItem.safeParse(raw);
    if (del.success) return { id: del.data.id, deleted: true };
    const live = liveItem.safeParse(raw);
    if (!live.success) throw new ProtocolError(`Invalid ${String(live.error.issues[0]?.path[0] ?? 'item')}`);
    const o = live.data;
    return {
      id: o.id,
      deleted: false,
      xpath: o.xpath,
      percentage: o.percentage,
      summary: truncateUtf8((o.summary ?? '').replace(/\s+/g, ' ').trim(), SUMMARY_MAX),
      si: o.si ?? 0,
      pc: o.pc ?? 0,
      pp: o.pp ?? 0,
      name: o.name ?? '',
      vo: o.vo ?? null,
    };
  });
}

export function parseBookmarkQuery(query: Record<string, string | undefined>) {
  const parsed = z.object({
    cursor: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(PAGE_MAX).default(50),
  }).safeParse(query);
  if (!parsed.success) throw new ProtocolError('Invalid query');
  return parsed.data;
}

export const titleFor = (item: { name: string; summary: string }) =>
  (item.name.trim() || item.summary.trim() || 'Bookmark').slice(0, TITLE_MAX);

const nowSeconds = () => Math.floor(Date.now() / 1000);

type StoredBookmark = Awaited<ReturnType<BookmarkService['rows']>>[number];

/**
 * Device bookmarks are BookOrbit dogears, exchanged through its KOReader bookmark exchange keyed by
 * md5(datetime|pos). The local table is the device's revision log.
 */
export class BookmarkService {
  constructor(
    private readonly db: Db,
    private readonly bookorbit: BookOrbit,
    private readonly clippings: ClippingService,
    private readonly log: Logger,
  ) {}

  async page(document: string, file: ResolvedFile | null, cursor: number, limit: number) {
    const empty = { document, sync_version: SYNC_VERSION, cursor, more: false, items: [] as unknown[] };
    if (!file) return empty;
    const rows = await this.db.selectFrom('bookmarks').selectAll()
      .where('book_file_id', '=', file.bookFileId).where('revision', '>', cursor)
      .orderBy('revision').limit(limit + 1).execute() as BookmarkRow[];
    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;
    return { ...empty, cursor: page.length ? Number(page[page.length - 1].revision) : cursor, more, items: page.map(encodeBookmark) };
  }

  rows(bookFileId: number) {
    return this.db.selectFrom('bookmarks').selectAll().where('book_file_id', '=', bookFileId).execute();
  }

  /** Stores device uploads in the revision log, marking them for the next exchange. */
  async apply(file: ResolvedFile, items: IncomingBookmark[]): Promise<void> {
    for (const item of items) {
      await this.clippings.locked(`bookmark:${file.bookFileId}:${item.id}`, () =>
        (item.deleted ? this.storeDeletion(file, item.id) : this.storeLive(file, item)));
    }
  }

  private async storeDeletion(file: ResolvedFile, id: string): Promise<void> {
    const existing = await this.db.selectFrom('bookmarks').select(['deleted'])
      .where('book_file_id', '=', file.bookFileId).where('bookmark_id', '=', id).executeTakeFirst();
    if (existing?.deleted) return;
    bookmarksTransferred.inc({ direction: 'to_bookorbit', kind: 'deleted' });
    await this.db.transaction().execute(async (tx) => {
      const revision = await nextRevision(tx);
      const tombstone = { deleted: true, xpath: '', summary: '', name: '', title: '', vo: null, ko_dirty: false, revision };
      await tx.insertInto('bookmarks').values({ book_file_id: file.bookFileId, bookmark_id: id, book_id: file.bookId, ...tombstone })
        .onConflict((oc) => oc.columns(['book_file_id', 'bookmark_id']).doUpdateSet(tombstone))
        .execute();
    });
  }

  private async storeLive(file: ResolvedFile, item: LiveBookmark): Promise<void> {
    const existing = await this.db.selectFrom('bookmarks').selectAll()
      .where('book_file_id', '=', file.bookFileId).where('bookmark_id', '=', item.id).executeTakeFirst();
    const title = titleFor(item);
    const unchanged = existing && !existing.deleted && existing.title === title
      && existing.xpath === item.xpath && existing.name === item.name && existing.summary === item.summary
      && Math.abs(existing.percentage - item.percentage) < 1e-6 && existing.si === item.si && existing.pc === item.pc
      && existing.pp === item.pp && (existing.vo == null ? null : Number(existing.vo)) === item.vo;
    if (unchanged) return;
    const fresh = !existing || existing.deleted || existing.xpath !== item.xpath;
    const renamed = !fresh && existing!.title !== title;
    bookmarksTransferred.inc({ direction: 'to_bookorbit', kind: fresh ? 'created' : renamed ? 'renamed' : 'updated' });
    const fields = {
      book_id: file.bookId,
      deleted: false,
      xpath: item.xpath,
      percentage: item.percentage,
      summary: item.summary,
      si: item.si,
      pc: item.pc,
      pp: item.pp,
      name: item.name,
      vo: item.vo,
      title,
      ...(fresh ? { ko_datetime: null, ko_key: null, bookorbit_id: null } : {}),
      ...(fresh || renamed ? { ko_dirty: true } : {}),
    };
    await this.db.transaction().execute(async (tx) => {
      const revision = await nextRevision(tx);
      await tx.insertInto('bookmarks').values({ book_file_id: file.bookFileId, bookmark_id: item.id, ...fields, revision })
        .onConflict((oc) => oc.columns(['book_file_id', 'bookmark_id']).doUpdateSet({ ...fields, revision }))
        .execute();
    });
  }

  /** Runs BookOrbit's bookmark exchange for one book and applies what it returns. */
  exchange(file: ResolvedFile, auth: DeviceAuth): Promise<void> {
    return this.clippings.locked(`bookmark-exchange:${file.bookFileId}`, () => this.runExchange(file, auth));
  }

  private async runExchange(file: ResolvedFile, auth: DeviceAuth): Promise<void> {
    await this.identify(file);
    const rows = await this.rows(file.bookFileId);
    const live = rows.filter((r) => !r.deleted && r.ko_key && r.ko_datetime);
    const keys: ExchangeKey[] = live.map((r) => ({ k: r.ko_key!, dt: r.ko_datetime! }));
    const keysComplete = keys.length <= BOOKMARK_MAX_KEYS;
    const changes = live.filter((r) => r.ko_dirty);

    let outcome: Awaited<ReturnType<BookOrbit['exchangeBookmarks']>> | null = null;
    let first = true;
    for (let i = 0; first || i < changes.length; i += EXCHANGE_MAX_CHANGES) {
      const chunk = changes.slice(i, i + EXCHANGE_MAX_CHANGES);
      outcome = await this.bookorbit.exchangeBookmarks(auth, {
        hash: file.document,
        keys: first && keysComplete ? keys : [],
        keysComplete: first && keysComplete,
        changes: chunk.map(toKo),
      });
      refusal(outcome, file.document);
      if (chunk.length) {
        await this.db.updateTable('bookmarks').set({ ko_dirty: false })
          .where('book_file_id', '=', file.bookFileId).where('bookmark_id', 'in', chunk.map((c) => c.bookmark_id)).execute();
      }
      first = false;
    }
    if (keysComplete) {
      await this.db.updateTable('bookmarks').set({ ko_key: null, ko_datetime: null, bookorbit_id: null })
        .where('book_file_id', '=', file.bookFileId).where('deleted', '=', true).where('ko_key', 'is not', null).execute();
    }

    for (let round = 0; outcome && round < MAX_ROUNDS; round++) {
      const result = outcome.results.find((r) => r.hash === file.document);
      if (!result) break;
      const { add, delete: deletes } = result.toApply;
      if (!add.length && !deletes.length) break;
      const applied: BookmarkAckApplied[] = [];
      const deleted: AckDeleted[] = [];
      const spines = (await this.clippings.book(file.bookFileId))?.spine.length ?? 0;
      for (const entry of add) applied.push(await this.applyRemote(file, entry, spines));
      for (const entry of deletes) deleted.push(await this.applyRemoteDelete(file, entry));
      await this.bookorbit.ackBookmarks(auth, { hash: file.document, applied, deleted });
      if (!result.more) break;
      outcome = await this.bookorbit.exchangeBookmarks(auth, { hash: file.document, keys: [], keysComplete: false, changes: [] });
      refusal(outcome, file.document);
    }
  }

  /** Gives every live device bookmark a KOReader identity. */
  private async identify(file: ResolvedFile): Promise<void> {
    const rows = await this.db.selectFrom('bookmarks').select(['bookmark_id', 'xpath'])
      .where('book_file_id', '=', file.bookFileId).where('deleted', '=', false).where('ko_datetime', 'is', null)
      // Rows written through the old REST API wait for BookOrbit to hand them back with their identity.
      .where('bookorbit_id', 'is', null).execute();
    if (!rows.length) return;
    const used = new Set((await this.db.selectFrom('bookmarks').select('ko_datetime').where('book_file_id', '=', file.bookFileId)
      .where('ko_datetime', 'is not', null).execute()).map((r) => r.ko_datetime!));
    let seconds = nowSeconds();
    for (const row of rows) {
      while (used.has(koDatetime(seconds))) seconds -= 1;
      const datetime = koDatetime(seconds);
      used.add(datetime);
      await this.db.updateTable('bookmarks').set({ ko_datetime: datetime, ko_key: koKey(datetime, row.xpath), ko_dirty: true })
        .where('book_file_id', '=', file.bookFileId).where('bookmark_id', '=', row.bookmark_id).execute();
    }
  }

  private async applyRemote(file: ResolvedFile, entry: BookmarkAddEntry, spines: number): Promise<BookmarkAckApplied> {
    const failed: BookmarkAckApplied = { serverId: entry.serverId, status: 'failed' };
    const point = parseXPointer(entry.pos);
    if (!point || entry.pos.length > XPATH_MAX) {
      bookmarksUnanchored.inc({ direction: 'to_device' });
      bookmarksTransferred.inc({ direction: 'to_device', kind: 'skipped' });
      return failed;
    }
    const id = bookmarkIdFor(entry.pos);
    const existing = await this.db.selectFrom('bookmarks').selectAll()
      .where('book_file_id', '=', file.bookFileId)
      .where((eb) => eb.or([eb('bookorbit_id', '=', entry.serverId), eb('bookmark_id', '=', id)]))
      .orderBy('deleted').executeTakeFirst();
    const datetime = existing?.ko_datetime ?? koDatetime(nowSeconds());
    const ack = { serverId: entry.serverId, status: 'applied' as const, key: koKey(datetime, existing?.xpath || entry.pos), datetime, pos: existing?.xpath || entry.pos };
    if (existing?.deleted && existing.bookmark_id !== `bookorbit-${entry.serverId}`) {
      // The device deleted it before BookOrbit had its key; the next key list reports the deletion.
      await this.db.updateTable('bookmarks').set({ ko_datetime: datetime, ko_key: ack.key, bookorbit_id: entry.serverId })
        .where('book_file_id', '=', file.bookFileId).where('bookmark_id', '=', existing.bookmark_id).execute();
      return ack;
    }
    const title = entry.title.slice(0, TITLE_MAX);
    if (existing && !existing.deleted) {
      const rename = existing.title !== title;
      await this.db.transaction().execute(async (tx) => {
        await tx.updateTable('bookmarks')
          .set({
            bookorbit_id: entry.serverId, ko_datetime: datetime, ko_key: ack.key, ko_dirty: false,
            ...(rename ? { title, name: title === 'Bookmark' ? '' : truncateUtf8(title, NAME_MAX), revision: await nextRevision(tx) } : {}),
          })
          .where('book_file_id', '=', file.bookFileId).where('bookmark_id', '=', existing.bookmark_id).execute();
      });
      if (rename) bookmarksTransferred.inc({ direction: 'to_device', kind: 'renamed' });
      return ack;
    }
    bookmarksTransferred.inc({ direction: 'to_device', kind: 'created' });
    const fields = {
      book_id: file.bookId,
      bookorbit_id: entry.serverId,
      deleted: false,
      xpath: entry.pos,
      percentage: spines ? Math.min(1, point.spine / spines) : 0,
      summary: truncateUtf8(title, SUMMARY_MAX),
      si: point.spine,
      pc: 0,
      pp: entry.pageno ?? 0,
      name: title === 'Bookmark' ? '' : truncateUtf8(title, NAME_MAX),
      vo: null,
      title,
      ko_datetime: datetime,
      ko_key: koKey(datetime, entry.pos),
      ko_dirty: false,
    };
    await this.db.transaction().execute(async (tx) => {
      const revision = await nextRevision(tx);
      await tx.insertInto('bookmarks').values({ book_file_id: file.bookFileId, bookmark_id: id, ...fields, revision })
        .onConflict((oc) => oc.columns(['book_file_id', 'bookmark_id']).doUpdateSet({ ...fields, revision }))
        .execute();
    });
    return { ...ack, key: fields.ko_key, pos: entry.pos };
  }

  private async applyRemoteDelete(file: ResolvedFile, entry: KoDeleteEntry): Promise<AckDeleted> {
    const existing = await this.db.selectFrom('bookmarks').select(['bookmark_id', 'deleted'])
      .where('book_file_id', '=', file.bookFileId).where('ko_key', '=', entry.key).executeTakeFirst();
    if (existing && !existing.deleted) {
      bookmarksTransferred.inc({ direction: 'to_device', kind: 'deleted' });
      await this.db.transaction().execute(async (tx) => {
        await tx.updateTable('bookmarks')
          .set({ deleted: true, bookorbit_id: null, xpath: '', summary: '', name: '', title: '', vo: null, ko_key: null, ko_datetime: null, ko_dirty: false, revision: await nextRevision(tx) })
          .where('book_file_id', '=', file.bookFileId).where('bookmark_id', '=', existing.bookmark_id).execute();
      });
    }
    return { serverId: entry.serverId, status: 'applied' };
  }
}

function toKo(row: StoredBookmark): KoBookmark {
  // A dogear's BookOrbit title is its note: the device name, else its summary, as before.
  const note = row.title === 'Bookmark' ? '' : row.title.trim();
  return { datetime: row.ko_datetime!, pos: row.xpath, ...(note ? { note } : {}), ...(row.pp ? { pageno: row.pp } : {}) };
}
