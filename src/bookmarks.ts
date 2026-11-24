import { createHash } from 'node:crypto';
import { z } from 'zod';

import { type BookOrbit, type Bookmark } from './bookorbit.js';
import type { ClippingService, ResolvedFile } from './clippings.js';
import { type Db, nextRevision } from './db.js';
import { spineCfiForChapterIndex } from './epub/cfi.js';
import { cfiToXPointer, parseXPointer, xpointerToCfi } from './epub/xpointer.js';
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

export class BookmarkService {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly db: Db,
    private readonly bookorbit: BookOrbit,
    private readonly clippings: ClippingService,
    private readonly log: Logger,
  ) {}

  async page(document: string, file: ResolvedFile | null, cursor: number, limit: number) {
    const empty = { document, sync_version: SYNC_VERSION, cursor, more: false, items: [] as unknown[] };
    if (!file) return empty;
    if (cursor === 0) await this.locked(`mirror:${file.bookFileId}`, () => this.mirror(file));
    const rows = await this.db.selectFrom('bookmarks').selectAll()
      .where('book_file_id', '=', file.bookFileId).where('revision', '>', cursor)
      .orderBy('revision').limit(limit + 1).execute() as BookmarkRow[];
    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;
    return { ...empty, cursor: page.length ? Number(page[page.length - 1].revision) : cursor, more, items: page.map(encodeBookmark) };
  }

  async apply(file: ResolvedFile, items: IncomingBookmark[]): Promise<void> {
    for (const item of items) {
      await this.locked(`${file.bookFileId}:${item.id}`, () =>
        item.deleted ? this.applyDeletion(file, item.id) : this.applyLive(file, item));
    }
  }

  private async locked(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    this.locks.set(key, tail);
    try {
      await run;
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  private async applyDeletion(file: ResolvedFile, id: string): Promise<void> {
    const existing = await this.db.selectFrom('bookmarks').select(['bookorbit_id', 'deleted'])
      .where('book_file_id', '=', file.bookFileId).where('bookmark_id', '=', id).executeTakeFirst();
    if (existing?.deleted) return;
    if (existing?.bookorbit_id != null) await this.bookorbit.deleteBookmark(file.bookId, existing.bookorbit_id);
    bookmarksTransferred.inc({ direction: 'to_bookorbit', kind: 'deleted' });
    await this.db.transaction().execute(async (tx) => {
      const revision = await nextRevision(tx);
      const tombstone = { deleted: true, bookorbit_id: null, xpath: '', summary: '', name: '', title: '', vo: null, revision };
      await tx.insertInto('bookmarks').values({ book_file_id: file.bookFileId, bookmark_id: id, book_id: file.bookId, ...tombstone })
        .onConflict((oc) => oc.columns(['book_file_id', 'bookmark_id']).doUpdateSet(tombstone))
        .execute();
    });
  }

  private async applyLive(file: ResolvedFile, item: LiveBookmark): Promise<void> {
    const existing = await this.db.selectFrom('bookmarks').selectAll()
      .where('book_file_id', '=', file.bookFileId).where('bookmark_id', '=', item.id).executeTakeFirst();
    const title = titleFor(item);
    let bookorbitId = existing && !existing.deleted ? existing.bookorbit_id : null;
    if (bookorbitId == null) {
      bookorbitId = await this.createBookmark(file, item, title);
      bookmarksTransferred.inc({ direction: 'to_bookorbit', kind: 'created' });
    } else if (existing!.title !== title) {
      await this.bookorbit.updateBookmark(file.bookId, bookorbitId, { title });
      bookmarksTransferred.inc({ direction: 'to_bookorbit', kind: 'renamed' });
    }
    const unchanged = existing && !existing.deleted && existing.bookorbit_id === bookorbitId && existing.title === title
      && existing.xpath === item.xpath && existing.name === item.name && existing.summary === item.summary
      && Math.abs(existing.percentage - item.percentage) < 1e-6 && existing.si === item.si && existing.pc === item.pc
      && existing.pp === item.pp && (existing.vo == null ? null : Number(existing.vo)) === item.vo;
    if (unchanged) return;
    const fields = {
      book_id: file.bookId,
      bookorbit_id: bookorbitId,
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
    };
    await this.db.transaction().execute(async (tx) => {
      const revision = await nextRevision(tx);
      await tx.insertInto('bookmarks').values({ book_file_id: file.bookFileId, bookmark_id: item.id, ...fields, revision })
        .onConflict((oc) => oc.columns(['book_file_id', 'bookmark_id']).doUpdateSet({ ...fields, revision }))
        .execute();
    });
  }

  private async createBookmark(file: ResolvedFile, item: LiveBookmark, title: string): Promise<number> {
    const book = await this.clippings.book(file.bookFileId);
    const converted = book ? xpointerToCfi(book, item.xpath) : null;
    // Without an exact anchor the bookmark still lands at the start of its chapter.
    const cfi = converted?.cfi ?? spineCfiForChapterIndex(parseXPointer(item.xpath)?.spine ?? item.si);
    if (!converted?.exact) {
      bookmarksUnanchored.inc({ direction: 'to_bookorbit' });
      this.log.warn('bookmark not anchored exactly', { bookFileId: file.bookFileId, bookmarkId: item.id, cfi });
    }
    const created = await this.bookorbit.createBookmark(file.bookId, { bookFileId: file.bookFileId, cfi, title });
    return created.id;
  }

  private async mirror(file: ResolvedFile): Promise<void> {
    const remote = await this.bookorbit.listBookmarks(file.bookId, file.bookFileId);
    const byId = new Map(remote.map((b) => [b.id, b]));
    const mapped = await this.db.selectFrom('bookmarks').select(['bookmark_id', 'bookorbit_id', 'deleted', 'title'])
      .where('book_file_id', '=', file.bookFileId).where('bookorbit_id', 'is not', null)
      .$narrowType<{ bookorbit_id: number }>().execute();
    const known = new Set(mapped.map((m) => m.bookorbit_id));

    const orphaned = mapped.filter((m) => !m.deleted && !byId.has(m.bookorbit_id));
    const renamed = mapped.filter((m) => !m.deleted && byId.has(m.bookorbit_id) && byId.get(m.bookorbit_id)!.title !== m.title);
    if (orphaned.length) bookmarksTransferred.inc({ direction: 'to_device', kind: 'deleted' }, orphaned.length);
    if (renamed.length) bookmarksTransferred.inc({ direction: 'to_device', kind: 'renamed' }, renamed.length);
    if (orphaned.length || renamed.length) {
      await this.db.transaction().execute(async (tx) => {
        for (const { bookmark_id } of orphaned) {
          await tx.updateTable('bookmarks')
            .set({ deleted: true, bookorbit_id: null, xpath: '', summary: '', name: '', title: '', vo: null, revision: await nextRevision(tx) })
            .where('book_file_id', '=', file.bookFileId).where('bookmark_id', '=', bookmark_id).execute();
        }
        for (const { bookmark_id, bookorbit_id } of renamed) {
          const title = byId.get(bookorbit_id)!.title;
          await tx.updateTable('bookmarks')
            .set({ title, name: truncateUtf8(title, NAME_MAX), revision: await nextRevision(tx) })
            .where('book_file_id', '=', file.bookFileId).where('bookmark_id', '=', bookmark_id).execute();
        }
      });
    }

    const candidates = remote.filter((b) => !known.has(b.id));
    if (!candidates.length) return;
    const book = await this.clippings.book(file.bookFileId);
    if (!book) return;
    for (const bookmark of candidates) await this.adopt(file, bookmark, book.spine.length, bookmark.cfi ? cfiToXPointer(book, bookmark.cfi) : null);
  }

  private async adopt(file: ResolvedFile, bookmark: Bookmark, spines: number, point: { xpath: string; spine: number } | null) {
    const live = point != null && point.xpath.length <= XPATH_MAX;
    bookmarksTransferred.inc({ direction: 'to_device', kind: live ? 'created' : 'skipped' });
    if (!live) {
      bookmarksUnanchored.inc({ direction: 'to_device' });
      // Unconvertible bookmarks become tombstones so later pulls do not retry them.
      await this.db.transaction().execute(async (tx) => tx.insertInto('bookmarks').values({
        book_file_id: file.bookFileId, bookmark_id: `bookorbit-${bookmark.id}`, book_id: file.bookId, bookorbit_id: bookmark.id,
        deleted: true, revision: await nextRevision(tx),
      }).onConflict((oc) => oc.doNothing()).execute());
      return;
    }
    const id = bookmarkIdFor(point.xpath);
    const existing = await this.db.selectFrom('bookmarks').select(['bookorbit_id', 'deleted'])
      .where('book_file_id', '=', file.bookFileId).where('bookmark_id', '=', id).executeTakeFirst();
    if (existing && !existing.deleted) {
      if (existing.bookorbit_id == null) {
        // An unlinked device bookmark at the same spot adopts this BookOrbit bookmark.
        await this.db.updateTable('bookmarks').set({ bookorbit_id: bookmark.id, title: bookmark.title })
          .where('book_file_id', '=', file.bookFileId).where('bookmark_id', '=', id).execute();
      } else {
        // A duplicate of a mapped bookmark is remembered as a tombstone so it is not retried.
        await this.db.transaction().execute(async (tx) => tx.insertInto('bookmarks').values({
          book_file_id: file.bookFileId, bookmark_id: `bookorbit-${bookmark.id}`, book_id: file.bookId, bookorbit_id: bookmark.id,
          deleted: true, revision: await nextRevision(tx),
        }).onConflict((oc) => oc.doNothing()).execute());
      }
      return;
    }
    const name = bookmark.title === 'Bookmark' ? '' : truncateUtf8(bookmark.title, NAME_MAX);
    const fields = {
      book_id: file.bookId,
      bookorbit_id: bookmark.id,
      deleted: false,
      xpath: point.xpath,
      percentage: spines ? Math.min(1, point.spine / spines) : 0,
      summary: truncateUtf8(bookmark.title, SUMMARY_MAX),
      si: point.spine,
      pc: 0,
      pp: 0,
      name,
      vo: null,
      title: bookmark.title,
    };
    await this.db.transaction().execute(async (tx) => {
      const revision = await nextRevision(tx);
      await tx.insertInto('bookmarks').values({ book_file_id: file.bookFileId, bookmark_id: id, ...fields, revision })
        .onConflict((oc) => oc.columns(['book_file_id', 'bookmark_id']).doUpdateSet({ ...fields, revision }))
        .execute();
    });
  }
}
