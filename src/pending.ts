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

  /** The stored items in upload order. */
  async peek<T>(username: string, document: string, kind: string): Promise<T[]> {
    const rows = await this.db.selectFrom('pending_items').select(['payload'])
      .where('username', '=', username).where('document', '=', document.toLowerCase()).where('kind', '=', kind)
      .orderBy('updated_at').execute();
    return rows.map((r) => (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as T);
  }

  async remove(username: string, document: string, kind: string, ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.db.deleteFrom('pending_items')
      .where('username', '=', username).where('document', '=', document.toLowerCase()).where('kind', '=', kind)
      .where('item_id', 'in', ids).execute();
  }

  async count(username: string, document: string, kind: string): Promise<number> {
    const row = await this.db.selectFrom('pending_items').select((eb) => eb.fn.countAll<number>().as('n'))
      .where('username', '=', username).where('document', '=', document.toLowerCase()).where('kind', '=', kind)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }
}
