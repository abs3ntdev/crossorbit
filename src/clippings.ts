import { type BookOrbit, BookOrbitError, type DeviceAuth } from './bookorbit.js';
import { type Db, nextRevision, now } from './db.js';
import { EpubBook, Lru } from './epub/book.js';
import { clippingToXPointers, xpointersToOffsets } from './epub/xpointer.js';
import {
  type AckDeleted, type AnnotationAckApplied, EXCHANGE_MAX_CHANGES, EXCHANGE_MAX_KEYS, type ExchangeKey, type ExchangeOutcome, fromKoDatetime,
  type KoAddEntry, type KoAnnotation, koDatetime, type KoDeleteEntry, type KoEditEntry, koKey, MAX_ROUNDS,
} from './exchange.js';
import type { Logger } from './log.js';
import { clippingsTransferred, clippingsUnanchored, epubLoads } from './metrics.js';
import { CHAPTER_MAX, type ClippingRow, encodeItem, type IncomingItem, type LiveItem, SYNC_VERSION, TEXT_MAX_BYTES, truncateUtf8 } from './protocol.js';

const RESOLVE_TTL_MS = 10 * 60 * 1000;
const NOTE_MAX = 5000;

export interface ResolvedFile {
  bookId: number;
  bookFileId: number;
  document: string;
}

export type ExchangeProblem = 'unmatched' | 'position_incompatible';

/** Thrown when BookOrbit will not exchange a book; the caller keeps the device data pending. */
export class ExchangeRefused extends Error {
  constructor(readonly problem: ExchangeProblem) {
    super(problem);
  }
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

type StoredClip = Awaited<ReturnType<ClippingService['rows']>>[number];

/**
 * Device clippings are BookOrbit highlights. The local table is the device's revision log; BookOrbit
 * owns the highlight through its KOReader annotation exchange, keyed by md5(datetime|pos0).
 */
export class ClippingService {
  private readonly books = new Lru<number, Promise<EpubBook | null>>(8);
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: Db,
    private readonly bookorbit: BookOrbit,
    private readonly log: Logger,
  ) {}

  async resolve(document: string, auth: DeviceAuth): Promise<ResolvedFile | null> {
    const key = document.toLowerCase();
    const cached = await this.db.selectFrom('documents').select(['book_id', 'book_file_id', 'resolved_at'])
      .where('document', '=', key).executeTakeFirst();
    if (cached && Date.now() - new Date(cached.resolved_at).getTime() < RESOLVE_TTL_MS) {
      // Cached mappings still need the device credentials checked (briefly cached by the client).
      await this.bookorbit.checkDevice(auth);
      return { bookId: cached.book_id, bookFileId: cached.book_file_id, document: key };
    }
    const hint = await this.db.selectFrom('document_hints').select(['title', 'authors'])
      .where('username', '=', auth.user).where('document', '=', key).executeTakeFirst();
    const match = await this.bookorbit.resolve(key, auth, hint);
    if (!match) return null;
    await this.db.insertInto('documents').values({ document: key, book_id: match.bookId, book_file_id: match.bookFileId })
      .onConflict((oc) => oc.column('document').doUpdateSet({ book_id: match.bookId, book_file_id: match.bookFileId, resolved_at: now(this.db) }))
      .execute();
    return { ...match, document: key };
  }

  /** Serializes work per key; the exchange for one book must not interleave with itself. */
  locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    this.locks.set(key, tail);
    return run.finally(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
  }

  async page(document: string, file: ResolvedFile | null, cursor: number, limit: number) {
    const empty = { document, sync_version: SYNC_VERSION, cursor, until: nowSeconds(), more: false, items: [] as unknown[] };
    if (!file) return empty;
    const rows: ClippingRow[] = await this.db.selectFrom('clippings').selectAll()
      .where('book_file_id', '=', file.bookFileId).where('revision', '>', cursor)
      .orderBy('revision').limit(limit + 1).execute() as never;
    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;
    return { ...empty, cursor: page.length ? Number(page[page.length - 1].revision) : cursor, more, items: page.map(encodeItem) };
  }

  /** Stores device uploads in the revision log, marking them for the next exchange. */
  async apply(file: ResolvedFile, items: IncomingItem[]): Promise<void> {
    for (const item of items) {
      await this.locked(`${file.bookFileId}:${item.id}`, () => (item.deleted ? this.storeDeletion(file, item.id) : this.storeLive(file, item)));
    }
  }

  private async storeDeletion(file: ResolvedFile, id: string): Promise<void> {
    const existing = await this.db.selectFrom('clippings').select(['deleted'])
      .where('book_file_id', '=', file.bookFileId).where('clipping_id', '=', id).executeTakeFirst();
    if (existing?.deleted) return;
    clippingsTransferred.inc({ direction: 'to_bookorbit', kind: 'deleted' });
    // A tombstone keeps its key until the next exchange leaves it out of the key list.
    await this.db.transaction().execute(async (tx) => {
      const revision = await nextRevision(tx);
      await tx.insertInto('clippings').values({ book_file_id: file.bookFileId, clipping_id: id, book_id: file.bookId, deleted: true, revision })
        .onConflict((oc) => oc.columns(['book_file_id', 'clipping_id']).doUpdateSet({ deleted: true, text: '', chapter: '', note: null, revision }))
        .execute();
    });
  }

  private async storeLive(file: ResolvedFile, item: LiveItem): Promise<void> {
    const existing = await this.db.selectFrom('clippings').selectAll()
      .where('book_file_id', '=', file.bookFileId).where('clipping_id', '=', item.id).executeTakeFirst();
    if (existing?.deleted) return;
    const moved = !existing || existing.text !== item.text || existing.spine !== item.spine
      || existing.start_offset !== item.start_offset || existing.end_offset !== item.end_offset;
    const createdAt = item.created_at || Number(existing?.created_at ?? 0) || nowSeconds();
    const fields = {
      book_id: file.bookId,
      spine: item.spine,
      start_page: item.start_page,
      end_page: item.end_page,
      pages: item.pages,
      start_word: item.start_word,
      end_word: item.end_word,
      words: item.words,
      para: item.para,
      chapter: item.chapter,
      text: item.text,
      created_at: createdAt,
      layout_signature: item.layout_signature,
      start_offset: item.start_offset,
      end_offset: item.end_offset,
      ...(moved ? { ko_dirty: true } : {}),
    };
    if (moved) clippingsTransferred.inc({ direction: 'to_bookorbit', kind: existing ? 'updated' : 'created' });
    await this.db.transaction().execute(async (tx) => {
      const revision = await nextRevision(tx);
      await tx.insertInto('clippings').values({ book_file_id: file.bookFileId, clipping_id: item.id, ...fields, revision })
        .onConflict((oc) => oc.columns(['book_file_id', 'clipping_id']).doUpdateSet({ ...fields, revision }).where('clippings.deleted', '=', false))
        .execute();
    });
  }

  rows(bookFileId: number) {
    return this.db.selectFrom('clippings').selectAll().where('book_file_id', '=', bookFileId).execute();
  }

  /**
   * Runs BookOrbit's annotation exchange for one book: sends every live key and the changed
   * highlights, applies what BookOrbit returns to the revision log, and acknowledges it.
   */
  exchange(file: ResolvedFile, auth: DeviceAuth): Promise<void> {
    return this.locked(`exchange:${file.bookFileId}`, () => this.runExchange(file, auth));
  }

  private async runExchange(file: ResolvedFile, auth: DeviceAuth): Promise<void> {
    const book = await this.book(file.bookFileId);
    if (!book) return;
    await this.anchor(file, book);
    const rows = await this.rows(file.bookFileId);
    const live = rows.filter((r) => !r.deleted && r.ko_key && r.ko_datetime && r.pos0);
    const keys: ExchangeKey[] = live.map((r) => ({ k: r.ko_key!, dt: r.ko_datetime! }));
    const keysComplete = keys.length <= EXCHANGE_MAX_KEYS;
    const changes = live.filter((r) => r.ko_dirty).map(toKo);

    let outcome: ExchangeOutcome<{ hash: string; toApply: { add: KoAddEntry[]; edit: KoEditEntry[]; delete: KoDeleteEntry[] }; more: boolean }> | null = null;
    let first = true;
    for (let i = 0; first || i < changes.length; i += EXCHANGE_MAX_CHANGES) {
      const chunk = changes.slice(i, i + EXCHANGE_MAX_CHANGES);
      outcome = await this.bookorbit.exchangeAnnotations(auth, {
        hash: file.document,
        keys: first && keysComplete ? keys : [],
        keysComplete: first && keysComplete,
        changes: chunk.map((c) => c.annotation),
      });
      refusal(outcome, file.document);
      if (chunk.length) {
        await this.db.updateTable('clippings').set({ ko_dirty: false })
          .where('book_file_id', '=', file.bookFileId).where('clipping_id', 'in', chunk.map((c) => c.id)).execute();
      }
      first = false;
    }
    // Device deletions: tombstones whose keys just left the list are done once BookOrbit saw the list.
    if (keysComplete) {
      await this.db.updateTable('clippings').set({ ko_key: null, ko_datetime: null, pos0: null, pos1: null })
        .where('book_file_id', '=', file.bookFileId).where('deleted', '=', true).where('ko_key', 'is not', null).execute();
    }

    for (let round = 0; outcome && round < MAX_ROUNDS; round++) {
      const result = outcome.results.find((r) => r.hash === file.document);
      if (!result) break;
      const { add, edit, delete: deletes } = result.toApply;
      if (!add.length && !edit.length && !deletes.length) break;
      const applied: AnnotationAckApplied[] = [];
      const deleted: AckDeleted[] = [];
      for (const entry of [...add, ...edit]) applied.push(await this.applyRemote(file, book, entry));
      for (const entry of deletes) deleted.push(await this.applyRemoteDelete(file, entry));
      await this.bookorbit.ackAnnotations(auth, { hash: file.document, applied, deleted });
      if (!result.more) break;
      outcome = await this.bookorbit.exchangeAnnotations(auth, { hash: file.document, keys: [], keysComplete: false, changes: [] });
      refusal(outcome, file.document);
    }
  }

  /**
   * Gives every new or moved clipping a KOReader identity and range. One that cannot be placed keeps
   * its previous anchor, so BookOrbit keeps the old highlight rather than losing it.
   */
  private async anchor(file: ResolvedFile, book: EpubBook): Promise<void> {
    const rows = await this.db.selectFrom('clippings').selectAll().where('book_file_id', '=', file.bookFileId)
      .where('deleted', '=', false)
      .where((eb) => eb.or([eb('ko_dirty', '=', true), eb('pos0', 'is', null), eb('ko_datetime', 'is', null)]))
      // Rows written through the old REST API wait for BookOrbit to hand them back with their identity.
      .where((eb) => eb.or([eb('annotation_id', 'is', null), eb('ko_datetime', 'is not', null)])).execute();
    if (!rows.length) return;
    const used = new Set((await this.db.selectFrom('clippings').select('ko_datetime').where('book_file_id', '=', file.bookFileId)
      .where('ko_datetime', 'is not', null).execute()).map((r) => r.ko_datetime!));
    for (const row of rows) {
      const range = clippingToXPointers(book, {
        spine: row.spine, text: row.text,
        startOffset: row.start_offset == null ? null : Number(row.start_offset), endOffset: row.end_offset == null ? null : Number(row.end_offset),
      });
      if (!range) {
        clippingsUnanchored.inc({ direction: 'to_bookorbit' });
        this.log.warn('clipping not anchored', { bookFileId: file.bookFileId, clippingId: row.clipping_id });
        if (row.ko_dirty) {
          await this.db.updateTable('clippings').set({ ko_dirty: false })
            .where('book_file_id', '=', file.bookFileId).where('clipping_id', '=', row.clipping_id).execute();
        }
        continue;
      }
      if (row.ko_datetime && row.pos0 === range.pos0 && row.pos1 === range.pos1 && !row.ko_dirty) continue;
      let datetime = row.ko_datetime;
      if (!datetime) {
        // KOReader treats the datetime as identity, so two clippings made in one second get distinct ones.
        let seconds = Number(row.created_at) || nowSeconds();
        while (used.has(koDatetime(seconds))) seconds += 1;
        datetime = koDatetime(seconds);
        used.add(datetime);
      }
      await this.db.updateTable('clippings')
        .set({ ko_datetime: datetime, ko_key: koKey(datetime, range.pos0), pos0: range.pos0, pos1: range.pos1, ko_dirty: true })
        .where('book_file_id', '=', file.bookFileId).where('clipping_id', '=', row.clipping_id).execute();
    }
  }

  /** Applies a BookOrbit add or edit to the revision log, answering with the ack entry. */
  private async applyRemote(file: ResolvedFile, book: EpubBook, entry: KoAddEntry | KoEditEntry): Promise<AnnotationAckApplied> {
    const failed: AnnotationAckApplied = { serverId: entry.serverId, version: entry.version, status: 'failed' };
    const isEdit = 'key' in entry;
    const find = () => this.db.selectFrom('clippings').selectAll().where('book_file_id', '=', file.bookFileId);
    const existing = isEdit
      ? await find().where('ko_key', '=', entry.key).executeTakeFirst()
      : (await find().where('annotation_id', '=', entry.serverId).where('deleted', '=', false).executeTakeFirst())
        ?? (entry.datetime ? await find().where('ko_datetime', '=', entry.datetime).where('deleted', '=', false).executeTakeFirst() : undefined);
    const pos0 = entry.pos0 ?? existing?.pos0 ?? null;
    const pos1 = (entry.pos1 ?? existing?.pos1) || null;
    if ('posFormat' in entry && entry.posFormat !== 'xpointer') return failed;
    if (!pos0) return failed;
    if (!isEdit && !existing && entry.datetime) {
      // A highlight the device already deleted (made before the exchange, so BookOrbit never had its key):
      // linking the tombstone lets the next exchange's key list report the deletion.
      const gone = await find().where('annotation_id', '=', entry.serverId).where('deleted', '=', true)
        .where('clipping_id', 'not like', 'bookorbit-%').executeTakeFirst();
      if (gone) {
        await this.db.updateTable('clippings').set({ ko_datetime: entry.datetime, ko_key: koKey(entry.datetime, pos0), pos0, pos1 })
          .where('book_file_id', '=', file.bookFileId).where('clipping_id', '=', gone.clipping_id).execute();
        return { serverId: entry.serverId, version: entry.version, status: 'applied', verified: true };
      }
    }
    const placed = xpointersToOffsets(book, { pos0, pos1 }, entry.text || null);
    if (!placed || Buffer.byteLength(placed.text) > TEXT_MAX_BYTES) {
      clippingsUnanchored.inc({ direction: 'to_device' });
      clippingsTransferred.inc({ direction: 'to_device', kind: 'skipped' });
      return failed;
    }
    const datetime = entry.datetime ?? existing?.ko_datetime ?? koDatetime(nowSeconds());
    const fields = {
      book_id: file.bookId,
      annotation_id: entry.serverId,
      deleted: false,
      spine: placed.spine,
      chapter: truncateUtf8((entry.chapter ?? existing?.chapter ?? '').slice(0, CHAPTER_MAX), CHAPTER_MAX),
      text: placed.text,
      start_offset: placed.start,
      end_offset: placed.end,
      note: entry.note ? entry.note.slice(0, NOTE_MAX) : null,
      color: entry.color || null,
      ko_datetime: datetime,
      ko_key: koKey(datetime, pos0),
      pos0,
      pos1,
      ko_dirty: false,
    };
    const changed = !existing || existing.text !== fields.text || existing.start_offset == null
      || Number(existing.start_offset) !== fields.start_offset || Number(existing.end_offset) !== fields.end_offset
      || existing.spine !== fields.spine || existing.chapter !== fields.chapter;
    const id = existing?.clipping_id ?? `bookorbit-${entry.serverId}`;
    const createdAt = Number(existing?.created_at ?? 0) || fromKoDatetime(datetime) || nowSeconds();
    await this.db.transaction().execute(async (tx) => {
      if (existing && !changed) {
        await tx.updateTable('clippings').set(fields).where('book_file_id', '=', file.bookFileId).where('clipping_id', '=', id).execute();
        return;
      }
      const revision = await nextRevision(tx);
      await tx.insertInto('clippings').values({ book_file_id: file.bookFileId, clipping_id: id, ...fields, created_at: createdAt, revision })
        .onConflict((oc) => oc.columns(['book_file_id', 'clipping_id']).doUpdateSet({ ...fields, revision }))
        .execute();
    });
    if (changed) clippingsTransferred.inc({ direction: 'to_device', kind: existing ? 'updated' : 'created' });
    return {
      serverId: entry.serverId, version: entry.version, status: 'applied', verified: true,
      ...(entry.datetimeUpdated ? { datetimeUpdated: entry.datetimeUpdated } : {}),
    };
  }

  private async applyRemoteDelete(file: ResolvedFile, entry: KoDeleteEntry): Promise<AckDeleted> {
    const existing = await this.db.selectFrom('clippings').select(['clipping_id', 'deleted'])
      .where('book_file_id', '=', file.bookFileId).where('ko_key', '=', entry.key).executeTakeFirst();
    if (existing && !existing.deleted) {
      clippingsTransferred.inc({ direction: 'to_device', kind: 'deleted' });
      await this.db.transaction().execute(async (tx) => {
        await tx.updateTable('clippings')
          .set({ deleted: true, text: '', chapter: '', note: null, ko_key: null, ko_datetime: null, pos0: null, pos1: null, ko_dirty: false, revision: await nextRevision(tx) })
          .where('book_file_id', '=', file.bookFileId).where('clipping_id', '=', existing.clipping_id).execute();
      });
    }
    return { serverId: entry.serverId, status: 'applied' };
  }

  book(fileId: number): Promise<EpubBook | null> {
    let entry = this.books.get(fileId);
    if (!entry) {
      entry = this.bookorbit
        .downloadFile(fileId)
        .then((bytes) => {
          epubLoads.inc({ outcome: 'ok' });
          return new EpubBook(bytes);
        })
        .catch((error: unknown) => {
          epubLoads.inc({ outcome: 'error' });
          this.log.warn('epub load failed', { fileId, error: error instanceof Error ? error.message : String(error) });
          this.books.delete(fileId);
          if (error instanceof BookOrbitError && (error.status === 401 || error.status === 403)) throw error;
          return null;
        });
      this.books.set(fileId, entry);
    }
    return entry;
  }
}

function toKo(row: StoredClip): { id: string; annotation: KoAnnotation } {
  return {
    id: row.clipping_id,
    annotation: {
      datetime: row.ko_datetime!,
      drawer: 'lighten',
      ...(row.color ? { color: row.color } : {}),
      text: row.text.slice(0, 10000),
      ...(row.note ? { note: row.note } : {}),
      ...(row.chapter ? { chapter: row.chapter } : {}),
      posFormat: 'xpointer',
      pos0: row.pos0!,
      ...(row.pos1 ? { pos1: row.pos1 } : {}),
    },
  };
}

/** Throws when BookOrbit reported the book as unmatched or not position compatible. */
export function refusal(outcome: { unmatched: string[]; positionIncompatible: string[] }, document: string): void {
  if (outcome.unmatched.includes(document)) throw new ExchangeRefused('unmatched');
  if (outcome.positionIncompatible.includes(document)) throw new ExchangeRefused('position_incompatible');
}
