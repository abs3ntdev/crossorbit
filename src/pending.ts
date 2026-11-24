import { type Db, now } from './db.js';

/**
 * Items the device uploaded for a book BookOrbit cannot match yet. They are acknowledged at once,
 * as crosspoint-sync does, and replayed once the document resolves.
 */
export class PendingStore {
  constructor(private readonly db: Db) {}

  async put<T extends { id: string }>(username: string, document: string, kind: string, items: T[]): Promise<void> {
    for (const item of items) {
      await this.db.insertInto('pending_items')
        .values({ username, document: document.toLowerCase(), kind, item_id: item.id, payload: item })
        .onConflict((oc) => oc.columns(['username', 'document', 'kind', 'item_id']).doUpdateSet({ payload: item, updated_at: now(this.db) }))
        .execute();
    }
  }

  /** Runs `apply` on the stored items in upload order, removing each batch once it succeeds. */
  async drain<T>(username: string, document: string, kind: string, apply: (items: T[]) => Promise<void>): Promise<number> {
    const rows = await this.db.selectFrom('pending_items').select(['item_id', 'payload'])
      .where('username', '=', username).where('document', '=', document.toLowerCase()).where('kind', '=', kind)
      .orderBy('updated_at').execute();
    if (!rows.length) return 0;
    await apply(rows.map((r) => (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as T));
    await this.db.deleteFrom('pending_items')
      .where('username', '=', username).where('document', '=', document.toLowerCase()).where('kind', '=', kind)
      .where('item_id', 'in', rows.map((r) => r.item_id)).execute();
    return rows.length;
  }

  async count(username: string, document: string, kind: string): Promise<number> {
    const row = await this.db.selectFrom('pending_items').select((eb) => eb.fn.countAll<number>().as('n'))
      .where('username', '=', username).where('document', '=', document.toLowerCase()).where('kind', '=', kind)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }
}
