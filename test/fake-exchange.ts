import { createHash } from 'node:crypto';

/**
 * A small model of BookOrbit's KOReader plugin exchanges (koreader-annotation-exchange.service.ts and
 * koreader-bookmark-exchange.service.ts): device changes are ingested by md5(datetime|pos) key, a
 * complete key list reports device deletions, and unlinked or newer server rows are pushed down until
 * the device acks them.
 */
const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const DEVICE_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export interface ServerAnnotation {
  id: number;
  version: number;
  /** Version the device last acked, or -1 while it has never been linked. */
  linked: number;
  key: string | null;
  datetime: string;
  text: string;
  pos0: string;
  pos1: string;
  note: string | null;
  color: string;
  chapter: string | null;
  deleted: boolean;
}

export interface ServerBookmark {
  id: number;
  pos: string;
  title: string;
  pageno: number | null;
  key: string | null;
  dirty: boolean;
  deleted: boolean;
}

export class FakeExchange {
  annotations: ServerAnnotation[] = [];
  bookmarks: ServerBookmark[] = [];
  bodies: { path: string; body: Record<string, unknown> }[] = [];
  incompatible = new Set<string>();
  private nextId = 100;
  private minted = 0;

  constructor(private readonly known: (hash: string) => boolean) {}

  /** A highlight made on the web reader. */
  addAnnotation(a: { text: string; pos0: string; pos1: string; chapter?: string | null; note?: string | null }): ServerAnnotation {
    const row: ServerAnnotation = {
      id: this.nextId++, version: 1, linked: -1, key: null, datetime: this.mint(), color: 'yellow',
      chapter: null, note: null, deleted: false, ...a,
    };
    this.annotations.push(row);
    return row;
  }

  editAnnotation(row: ServerAnnotation, patch: Partial<Pick<ServerAnnotation, 'text' | 'pos0' | 'pos1' | 'note' | 'chapter'>>) {
    Object.assign(row, patch);
    row.version += 1;
  }

  live(text?: string) {
    return this.annotations.filter((a) => !a.deleted && (text === undefined || a.text === text));
  }

  addBookmark(b: { pos: string; title: string; pageno?: number | null }): ServerBookmark {
    const row: ServerBookmark = { id: this.nextId++, key: null, dirty: true, deleted: false, pageno: null, ...b };
    this.bookmarks.push(row);
    return row;
  }

  liveBookmarks() {
    return this.bookmarks.filter((b) => !b.deleted);
  }

  private mint() {
    const d = new Date(Date.UTC(2026, 0, 1) + 1000 * this.minted++);
    return d.toISOString().slice(0, 19).replace('T', ' ');
  }

  /** Answers a /api/v1/koreader/plugin/* exchange call, or null for other paths. */
  handle(path: string, body: Record<string, unknown>): { status: number; value: unknown } | null {
    const kind = /^\/api\/v1\/koreader\/plugin\/(annotations|bookmarks)\/(exchange|exchange-ack)$/.exec(path);
    if (!kind) return null;
    this.bodies.push({ path, body });
    if (!body.deviceId || !body.deviceModel || !body.pluginVersion || !DEVICE_DATETIME.test(String(body.deviceTime))) {
      return { status: 400, value: { message: 'device fields' } };
    }
    const books = body.books as Record<string, unknown>[];
    const results: unknown[] = [];
    const unmatched: string[] = [];
    const positionIncompatible: string[] = [];
    for (const book of books) {
      const hash = book.hash as string;
      if (!this.known(hash)) unmatched.push(hash);
      else if (this.incompatible.has(hash)) positionIncompatible.push(hash);
      else if (kind[1] === 'annotations') results.push(kind[2] === 'exchange' ? this.annotationExchange(book) : this.annotationAck(book));
      else results.push(kind[2] === 'exchange' ? this.bookmarkExchange(book) : this.bookmarkAck(book));
    }
    return { status: 201, value: { results, unmatched, positionIncompatible } };
  }

  private annotationExchange(book: Record<string, unknown>) {
    const keys = (book.keys as { k: string; dt: string }[]).map((k) => k.k);
    for (const change of book.changes as Record<string, string>[]) {
      if (book.sidecarState !== 'known') throw new Error('crossorbit must declare its sidecar known');
      const key = md5(`${change.datetime}|${change.pos0}`);
      const fields = { text: change.text ?? '', pos0: change.pos0, pos1: change.pos1 ?? change.pos0, note: change.note ?? null, chapter: change.chapter ?? null };
      const existing = this.annotations.find((a) => a.key === key && !a.deleted);
      if (existing) {
        Object.assign(existing, fields);
        existing.version += 1;
        existing.linked = existing.version;
      } else {
        this.annotations.push({ id: this.nextId++, version: 1, linked: 1, key, datetime: change.datetime, color: change.color ?? 'yellow', deleted: false, ...fields });
      }
    }
    if (book.keysComplete) {
      for (const a of this.annotations) {
        if (!a.deleted && a.key && a.linked >= 0 && !keys.includes(a.key)) {
          a.deleted = true;
          a.key = null;
        }
      }
    }
    const add = this.annotations.filter((a) => !a.deleted && a.linked < 0);
    const edit = this.annotations.filter((a) => !a.deleted && a.linked >= 0 && a.key && a.version > a.linked);
    const del = this.annotations.filter((a) => a.deleted && a.key);
    const page = 50;
    return {
      hash: book.hash,
      bookId: 1,
      toApply: {
        add: add.slice(0, page).map((a) => ({
          serverId: a.id, version: a.version, datetime: a.datetime, datetimeUpdated: null, drawer: 'lighten', color: a.color,
          text: a.text, note: a.note, chapter: a.chapter, posFormat: 'xpointer', pos0: a.pos0, pos1: a.pos1, pageno: null,
        })),
        edit: edit.map((a) => ({
          serverId: a.id, version: a.version, key: a.key, datetime: a.datetime, datetimeUpdated: '2026-02-01 00:00:00', drawer: 'lighten',
          color: a.color, text: a.text, note: a.note, chapter: a.chapter, pos0: a.pos0, pos1: a.pos1,
        })),
        delete: del.map((a) => ({ serverId: a.id, key: a.key, datetime: a.datetime })),
      },
      more: add.length > page,
    };
  }

  private annotationAck(book: Record<string, unknown>) {
    let acked = 0;
    for (const entry of book.applied as { serverId: number; version: number; status: string }[]) {
      const a = this.annotations.find((x) => x.id === entry.serverId);
      if (!a || entry.status !== 'applied') continue;
      a.key = md5(`${a.datetime}|${a.pos0}`);
      a.linked = entry.version;
      acked += 1;
    }
    for (const entry of book.deleted as { serverId: number; status: string }[]) {
      const a = this.annotations.find((x) => x.id === entry.serverId);
      if (a && entry.status === 'applied') {
        a.key = null;
        acked += 1;
      }
    }
    return { hash: book.hash, acked };
  }

  private bookmarkExchange(book: Record<string, unknown>) {
    const keys = (book.keys as { k: string }[]).map((k) => k.k);
    for (const change of book.changes as { datetime: string; pos: string; note?: string; pageno?: number }[]) {
      const key = md5(`${change.datetime}|${change.pos}`);
      const title = change.note?.trim() || (change.pageno != null ? `p. ${change.pageno}` : 'Bookmark');
      const existing = this.bookmarks.find((b) => b.key === key && !b.deleted);
      if (existing) existing.title = title;
      else this.bookmarks.push({ id: this.nextId++, pos: change.pos, title, pageno: change.pageno ?? null, key, dirty: false, deleted: false });
    }
    if (book.keysComplete) {
      for (const b of this.bookmarks) {
        if (!b.deleted && b.key && !keys.includes(b.key)) {
          b.deleted = true;
          b.key = null;
        }
      }
    }
    return {
      hash: book.hash,
      bookId: 1,
      toApply: {
        add: this.bookmarks.filter((b) => !b.deleted && b.dirty).map((b) => ({ serverId: b.id, pos: b.pos, pageno: b.pageno, title: b.title })),
        delete: this.bookmarks.filter((b) => b.deleted && b.key).map((b) => ({ serverId: b.id, key: b.key, datetime: null })),
      },
      more: false,
    };
  }

  private bookmarkAck(book: Record<string, unknown>) {
    let acked = 0;
    for (const entry of book.applied as { serverId: number; status: string; key?: string }[]) {
      const b = this.bookmarks.find((x) => x.id === entry.serverId);
      if (!b || entry.status !== 'applied' || !entry.key) continue;
      b.key = entry.key;
      b.dirty = false;
      acked += 1;
    }
    for (const entry of book.deleted as { serverId: number; status: string }[]) {
      const b = this.bookmarks.find((x) => x.id === entry.serverId);
      if (b && entry.status === 'applied') {
        b.key = null;
        acked += 1;
      }
    }
    return { hash: book.hash, acked };
  }
}
