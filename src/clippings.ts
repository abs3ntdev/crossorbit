import { createHash } from 'node:crypto';

import { type BookOrbit, BookOrbitError, type DeviceAuth } from './bookorbit.js';
import type { Sql } from './db.js';
import { EpubBook, Lru } from './epub/book.js';
import { cfiToClipping, clippingToCfi } from './epub/mapping.js';
import type { Logger } from './log.js';
import { CHAPTER_MAX, type ClippingRow, encodeItem, type IncomingItem, type LiveItem, SYNC_VERSION, TEXT_MAX_BYTES, truncateUtf8 } from './protocol.js';

const MIRROR_BATCH = 50;
const RESOLVE_TTL_MS = 10 * 60 * 1000;

export interface ResolvedFile {
  bookId: number;
  bookFileId: number;
}

export function clippingIdFor(createdAt: number, text: string): string {
  return createHash('sha256').update(`${createdAt}${text}`).digest('hex').slice(0, 16);
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

export class ClippingService {
  private readonly books = new Lru<number, Promise<EpubBook | null>>(8);

  constructor(
    private readonly sql: Sql,
    private readonly bookorbit: BookOrbit,
    private readonly log: Logger,
  ) {}

  async resolve(document: string, auth: DeviceAuth): Promise<ResolvedFile | null> {
    const key = document.toLowerCase();
    const [cached] = await this.sql<{ book_id: number; book_file_id: number; resolved_at: Date }[]>`
      SELECT book_id, book_file_id, resolved_at FROM documents WHERE document = ${key}`;
    if (cached && Date.now() - cached.resolved_at.getTime() < RESOLVE_TTL_MS) {
      // Cached mappings still need the device credentials checked on every request.
      const res = await this.bookorbit.device('/users/auth', auth);
      if (res.status === 401) throw new BookOrbitError(401, 'Unauthorized');
      return { bookId: cached.book_id, bookFileId: cached.book_file_id };
    }
    const match = await this.bookorbit.resolve(key, auth);
    if (!match) return null;
    await this.sql`
      INSERT INTO documents (document, book_id, book_file_id) VALUES (${key}, ${match.bookId}, ${match.bookFileId})
      ON CONFLICT (document) DO UPDATE SET book_id = excluded.book_id, book_file_id = excluded.book_file_id, resolved_at = now()`;
    return match;
  }

  async page(document: string, file: ResolvedFile | null, cursor: number, limit: number) {
    const empty = { document, sync_version: SYNC_VERSION, cursor, until: nowSeconds(), more: false, items: [] as unknown[] };
    if (!file) return empty;
    if (cursor === 0) await this.mirror(file);
    const rows = await this.sql<ClippingRow[]>`
      SELECT * FROM clippings WHERE book_file_id = ${file.bookFileId} AND revision > ${cursor}
      ORDER BY revision LIMIT ${limit + 1}`;
    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;
    return { ...empty, cursor: page.length ? Number(page[page.length - 1].revision) : cursor, more, items: page.map(encodeItem) };
  }

  async apply(file: ResolvedFile, items: IncomingItem[]): Promise<void> {
    for (const item of items) {
      if (item.deleted) await this.applyDeletion(file, item.id);
      else await this.applyLive(file, item);
    }
  }

  private async applyDeletion(file: ResolvedFile, id: string): Promise<void> {
    const [existing] = await this.sql<{ annotation_id: number | null; deleted: boolean }[]>`
      SELECT annotation_id, deleted FROM clippings WHERE book_file_id = ${file.bookFileId} AND clipping_id = ${id}`;
    if (existing?.deleted) return;
    if (existing?.annotation_id != null) await this.bookorbit.deleteAnnotation(file.bookId, existing.annotation_id);
    await this.sql`
      INSERT INTO clippings (book_file_id, clipping_id, book_id, deleted) VALUES (${file.bookFileId}, ${id}, ${file.bookId}, true)
      ON CONFLICT (book_file_id, clipping_id) DO UPDATE SET
        deleted = true, text = '', chapter = '', revision = nextval('clipping_revision')`;
  }

  private async applyLive(file: ResolvedFile, item: LiveItem): Promise<void> {
    const [existing] = await this.sql<(ClippingRow & { annotation_id: number | null })[]>`
      SELECT * FROM clippings WHERE book_file_id = ${file.bookFileId} AND clipping_id = ${item.id}`;
    if (existing?.deleted) return;
    let annotationId = existing?.annotation_id ?? null;
    const moved = existing && (existing.text !== item.text || existing.spine !== item.spine);
    if (!existing || moved || annotationId == null) {
      if (annotationId != null) await this.bookorbit.deleteAnnotation(file.bookId, annotationId);
      annotationId = await this.createAnnotation(file, item);
    }
    const createdAt = item.created_at || Number(existing?.created_at ?? 0) || nowSeconds();
    const fields = {
      book_file_id: file.bookFileId,
      clipping_id: item.id,
      book_id: file.bookId,
      annotation_id: annotationId,
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
    };
    await this.sql`
      INSERT INTO clippings ${this.sql(fields)}
      ON CONFLICT (book_file_id, clipping_id) DO UPDATE SET
        annotation_id = excluded.annotation_id, spine = excluded.spine, start_page = excluded.start_page,
        end_page = excluded.end_page, pages = excluded.pages, start_word = excluded.start_word, end_word = excluded.end_word,
        words = excluded.words, para = excluded.para, chapter = excluded.chapter, text = excluded.text,
        created_at = excluded.created_at, layout_signature = excluded.layout_signature,
        start_offset = excluded.start_offset, end_offset = excluded.end_offset,
        revision = nextval('clipping_revision')
      WHERE clippings.deleted = false`;
  }

  private async createAnnotation(file: ResolvedFile, item: LiveItem): Promise<number | null> {
    const book = await this.book(file.bookFileId);
    const cfi = book
      ? clippingToCfi(book, { spine: item.spine, text: item.text, startOffset: item.start_offset, endOffset: item.end_offset })
      : null;
    if (!cfi) {
      this.log.warn('clipping not anchored', { bookFileId: file.bookFileId, clippingId: item.id });
      return null;
    }
    const annotation = await this.bookorbit.createAnnotation(file.bookId, {
      cfi,
      text: item.text,
      chapterTitle: item.chapter || null,
      bookFileId: file.bookFileId,
    });
    return annotation.id;
  }

  private async mirror(file: ResolvedFile): Promise<void> {
    const annotations = await this.bookorbit.listAnnotations(file.bookId, file.bookFileId);
    const present = new Set(annotations.map((a) => a.id));
    const mapped = await this.sql<{ clipping_id: string; annotation_id: number; deleted: boolean }[]>`
      SELECT clipping_id, annotation_id, deleted FROM clippings
      WHERE book_file_id = ${file.bookFileId} AND annotation_id IS NOT NULL`;
    const known = new Set(mapped.map((m) => m.annotation_id));

    const orphaned = mapped.filter((m) => !m.deleted && !present.has(m.annotation_id)).slice(0, MIRROR_BATCH);
    if (orphaned.length) {
      await this.sql`
        UPDATE clippings SET deleted = true, text = '', chapter = '', revision = nextval('clipping_revision')
        WHERE book_file_id = ${file.bookFileId} AND clipping_id IN ${this.sql(orphaned.map((o) => o.clipping_id))}`;
    }

    const candidates = annotations.filter((a) => !known.has(a.id)).slice(0, MIRROR_BATCH);
    if (!candidates.length) return;
    const book = await this.book(file.bookFileId);
    for (const annotation of candidates) {
      const clipping = book && annotation.cfi ? cfiToClipping(book, annotation.cfi) : null;
      const createdAt = Math.floor(new Date(annotation.highlightedAt ?? annotation.createdAt).getTime() / 1000) || nowSeconds();
      const live = clipping && Buffer.byteLength(clipping.text) <= TEXT_MAX_BYTES;
      const id = live ? clippingIdFor(createdAt, clipping.text) : `bookorbit-${annotation.id}`;
      // Unanchorable annotations are recorded as tombstones so later pulls do not retry them.
      const inserted = await this.sql`
        INSERT INTO clippings ${this.sql({
          book_file_id: file.bookFileId,
          clipping_id: id,
          book_id: file.bookId,
          annotation_id: annotation.id,
          deleted: !live,
          spine: clipping?.spine ?? 0,
          chapter: live ? truncateUtf8((annotation.chapterTitle ?? '').slice(0, CHAPTER_MAX), CHAPTER_MAX) : '',
          text: live ? clipping.text : '',
          created_at: createdAt,
          start_offset: live ? clipping.startOffset : null,
          end_offset: live ? clipping.endOffset : null,
        })}
        ON CONFLICT DO NOTHING`;
      if (inserted.count === 0) {
        await this.sql`
          INSERT INTO clippings (book_file_id, clipping_id, book_id, annotation_id, deleted)
          VALUES (${file.bookFileId}, ${`bookorbit-${annotation.id}`}, ${file.bookId}, ${annotation.id}, true)
          ON CONFLICT DO NOTHING`;
      }
    }
  }

  private book(fileId: number): Promise<EpubBook | null> {
    let entry = this.books.get(fileId);
    if (!entry) {
      entry = this.bookorbit
        .downloadFile(fileId)
        .then((bytes) => new EpubBook(bytes))
        .catch((error: unknown) => {
          this.log.warn('epub load failed', { fileId, error: error instanceof Error ? error.message : String(error) });
          this.books.delete(fileId);
          return null;
        });
      this.books.set(fileId, entry);
    }
    return entry;
  }
}
