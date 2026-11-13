import { Hono } from 'hono';
import type { Child } from 'hono/jsx';
import { sql } from 'kysely';

import type { BookMeta, BookOrbit } from './bookorbit.js';
import type { Db } from './db.js';
import type { Logger } from './log.js';
import { lastSync } from './metrics.js';
import { CSS } from './ui-style.js';

const TTL = 60_000;

type Status = 'synced' | 'unanchored' | 'deleted';
type Meta = BookMeta | null | 'error';

interface Clip {
  book_file_id: number;
  book_id: number;
  clipping_id: string;
  annotation_id: number | null;
  revision: string | number;
  deleted: boolean | number;
  chapter: string;
  text: string;
  created_at: string | number;
}

const statusOf = (c: Clip): Status =>
  (c.deleted && c.clipping_id.startsWith('bookorbit-')) || c.annotation_id == null ? 'unanchored' : c.deleted ? 'deleted' : 'synced';

const toDate = (v: Date | string | number | null | undefined) => (v == null ? null : v instanceof Date ? v : new Date(v));

function ago(v: Date | string | number | null | undefined): string {
  const d = toDate(v);
  if (!d || Number.isNaN(d.getTime())) return 'never';
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const iso = (v: Date | string | number | null | undefined) => toDate(v)?.toISOString() ?? '';
const epoch = (v: string | number) => (Number(v) > 0 ? new Date(Number(v) * 1000) : null);
const pct = (p: number | null | undefined) => (p == null ? null : Math.max(0, Math.min(100, p * 100)));

function Time({ value }: { value: Date | string | number | null | undefined }) {
  const d = toDate(value);
  return d ? <time datetime={iso(d)} title={iso(d)}>{ago(d)}</time> : <span class="dim">never</span>;
}

function Page(props: { title: string; nav: string; health: Health; children: Child }) {
  return (
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <meta http-equiv="refresh" content="60" />
          <title>{`${props.title} · crossorbit`}</title>
          <style dangerouslySetInnerHTML={{ __html: CSS }} />
        </head>
        <body>
          <header class="top">
            <a class="mark" href="/">crossorbit</a>
            <nav>
              {[['/', 'Shelf'], ['/activity', 'Activity'], ['/problems', 'Problems']].map(([href, label]) => (
                <a href={href} aria-current={props.nav === href ? 'page' : undefined}>{label}</a>
              ))}
            </nav>
          </header>
          <HealthStrip health={props.health} />
          <main>{props.children}</main>
        </body>
      </html>
  );
}

interface Health {
  database: boolean;
  bookorbit: boolean;
  progress: Date | string | null;
  clippings: Date | string | null;
}

function HealthStrip({ health }: { health: Health }) {
  const dot = (ok: boolean, label: string) => (
    <span class={ok ? 'lamp on' : 'lamp off'}>
      <i aria-hidden="true" />
      {label} {ok ? 'up' : 'down'}
    </span>
  );
  return (
    <div class="health" role="status">
      {dot(health.database, 'Database')}
      {dot(health.bookorbit, 'BookOrbit')}
      <span>Progress sync <Time value={health.progress} /></span>
      <span>Highlight sync <Time value={health.clippings} /></span>
    </div>
  );
}

function Bar({ value }: { value: number | null }) {
  return (
    <div class="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value ?? undefined}>
      <span style={`width:${value ?? 0}%`} />
    </div>
  );
}

const Badge = ({ status }: { status: Status }) => <span class={`badge ${status}`}>{status}</span>;

const Empty = ({ children }: { children: Child }) => <p class="empty">{children}</p>;

export function createUi(db: Db, bookorbit: BookOrbit, log: Logger) {
  const app = new Hono();
  const metas = new Map<number, { at: number; value: Promise<Meta> }>();
  let ping: { at: number; value: Promise<boolean> } | null = null;

  const meta = (bookId: number): Promise<Meta> => {
    const hit = metas.get(bookId);
    if (hit && Date.now() - hit.at < TTL) return hit.value;
    const value = bookorbit.getBook(bookId).catch((error: unknown) => {
      log.warn('book lookup failed', { bookId, error: error instanceof Error ? error.message : String(error) });
      return 'error' as const;
    });
    metas.set(bookId, { at: Date.now(), value });
    return value;
  };

  async function health(): Promise<Health> {
    if (!ping || Date.now() - ping.at > 15_000) ping = { at: Date.now(), value: bookorbit.ping() };
    const [database, up, gauge, latest] = await Promise.all([
      sql`SELECT 1`.execute(db).then(() => true, () => false),
      ping.value,
      lastSync.get(),
      db.selectFrom('positions').select((eb) => eb.fn.max('updated_at').as('t')).executeTakeFirst().catch(() => undefined),
    ]);
    const at = (kind: string) => {
      const v = gauge.values.find((x) => x.labels.kind === kind)?.value;
      return v ? new Date(v * 1000) : null;
    };
    return { database, bookorbit: up, progress: at('progress') ?? (latest?.t as Date | string | null) ?? null, clippings: at('clippings') };
  }

  async function books() {
    const [documents, positions, counts] = await Promise.all([
      db.selectFrom('documents').selectAll().orderBy('resolved_at', 'desc').execute(),
      db.selectFrom('positions').selectAll().orderBy('updated_at', 'desc').execute(),
      db.selectFrom('clippings').select(['book_file_id', 'clipping_id', 'annotation_id', 'deleted']).execute(),
    ]);
    const files = new Map<number, { bookId: number; bookFileId: number; documents: string[]; resolvedAt: Date | string }>();
    for (const d of documents) {
      const f = files.get(d.book_file_id) ?? { bookId: d.book_id, bookFileId: d.book_file_id, documents: [], resolvedAt: d.resolved_at };
      f.documents.push(d.document);
      files.set(d.book_file_id, f);
    }
    return Promise.all([...files.values()].map(async (f) => {
      const position = positions.find((p) => f.documents.includes(p.document));
      const tally = { synced: 0, unanchored: 0, deleted: 0 };
      for (const c of counts) if (c.book_file_id === f.bookFileId) tally[statusOf(c as Clip)]++;
      return { ...f, position, tally, meta: await meta(f.bookId) };
    }));
  }

  const titleOf = (m: Meta, bookId: number) => (m && m !== 'error' && m.title) || `Book #${bookId}`;

  app.get('/', async (c) => {
    const [h, list] = await Promise.all([health(), books()]);
    return c.html('<!doctype html>' +
      <Page title="Shelf" nav="/" health={h}>
        <h1>Shelf</h1>
        {list.length === 0 ? (
          <Empty>No books yet. Sync a book from the CrossPoint device and it shows up here.</Empty>
        ) : (
          <ul class="shelf">
            {list.map((b) => {
              const p = pct(b.position?.percentage);
              return (
                <li>
                  <a class="card" href={`/books/${b.bookFileId}`}>
                    <div class="cover">
                      <img src={`/covers/${b.bookId}`} alt="" loading="lazy" />
                      <span class="ribbon" style={`height:${p ?? 0}%`} />
                    </div>
                    <div class="meta">
                      <h2>{titleOf(b.meta, b.bookId)}</h2>
                      {b.meta && b.meta !== 'error' && b.meta.authors.length > 0 && <p class="by">{b.meta.authors.join(', ')}</p>}
                      <p class="pct">{p == null ? '—' : `${p.toFixed(1)}%`}</p>
                      <p class="dim">Synced <Time value={b.position?.updated_at ?? b.resolvedAt} /></p>
                      <p class="tally">
                        <span class="synced">{b.tally.synced} synced</span>
                        <span class="unanchored">{b.tally.unanchored} unanchored</span>
                        <span class="deleted">{b.tally.deleted} deleted</span>
                      </p>
                    </div>
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </Page>,
    );
  });

  app.get('/books/:bookFileId{[0-9]+}', async (c) => {
    const bookFileId = Number(c.req.param('bookFileId'));
    const [h, docs, clips] = await Promise.all([
      health(),
      db.selectFrom('documents').selectAll().where('book_file_id', '=', bookFileId).execute(),
      db.selectFrom('clippings').selectAll().where('book_file_id', '=', bookFileId).orderBy('revision', 'desc').execute(),
    ]);
    const bookId = docs[0]?.book_id ?? clips[0]?.book_id;
    if (bookId == null) return c.notFound();
    const position = docs.length
      ? await db.selectFrom('positions').selectAll().where('document', 'in', docs.map((d) => d.document)).orderBy('updated_at', 'desc').executeTakeFirst()
      : undefined;
    const m = await meta(bookId);
    const p = pct(position?.percentage);
    return c.html('<!doctype html>' +
      <Page title={titleOf(m, bookId)} nav="" health={h}>
        <section class="hero">
          <img class="cover big" src={`/covers/${bookId}`} alt="" />
          <div>
            <h1>{titleOf(m, bookId)}</h1>
            {m && m !== 'error' && m.authors.length > 0 && <p class="by">{m.authors.join(', ')}</p>}
            {m === 'error' && <p class="warn">BookOrbit could not return this book's details.</p>}
            <p class="pct big">{p == null ? 'No position yet' : `${p.toFixed(1)}%`}</p>
            <Bar value={p} />
            <p class="dim">
              {position ? <>Last position from {position.username}, <Time value={position.updated_at} /></> : 'The device has not pushed a position for this book.'}
            </p>
            <p class="dim mono">file {bookFileId} · book {bookId} · {docs.map((d) => d.document).join(', ') || 'no document hash'}</p>
          </div>
        </section>
        <h2>Highlights</h2>
        {clips.length === 0 ? <Empty>No highlights for this book yet.</Empty> : <Clips rows={clips as Clip[]} />}
      </Page>,
    );
  });

  app.get('/activity', async (c) => {
    const [h, clips, positions] = await Promise.all([
      health(),
      db.selectFrom('clippings').selectAll().orderBy('revision', 'desc').limit(100).execute(),
      db.selectFrom('positions').select(['username', 'document', 'percentage', 'updated_at']).orderBy('updated_at', 'desc').limit(100).execute(),
    ]);
    return c.html('<!doctype html>' +
      <Page title="Activity" nav="/activity" health={h}>
        <h1>Activity</h1>
        <h2>Highlight changes</h2>
        {clips.length === 0 ? <Empty>No highlight changes recorded.</Empty> : <Clips rows={clips as Clip[]} book />}
        <h2>Reading positions</h2>
        {positions.length === 0 ? (
          <Empty>No positions pushed yet.</Empty>
        ) : (
          <table>
            <thead><tr><th>Reader</th><th>Document</th><th>Progress</th><th>Updated</th></tr></thead>
            <tbody>
              {positions.map((p) => (
                <tr>
                  <td>{p.username}</td>
                  <td class="mono">{p.document}</td>
                  <td><Bar value={pct(p.percentage)} /> {pct(p.percentage)!.toFixed(1)}%</td>
                  <td><Time value={p.updated_at} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Page>,
    );
  });

  app.get('/problems', async (c) => {
    const [h, clips, list] = await Promise.all([
      health(),
      db.selectFrom('clippings').selectAll()
        .where((eb) => eb.or([eb('annotation_id', 'is', null), eb.and([eb('clipping_id', 'like', 'bookorbit-%'), eb('deleted', '=', true)])]))
        .orderBy('revision', 'desc').limit(200).execute(),
      books(),
    ]);
    const failed = list.filter((b) => b.meta === 'error' || b.meta === null);
    return c.html('<!doctype html>' +
      <Page title="Problems" nav="/problems" health={h}>
        <h1>Problems</h1>
        <h2>Books BookOrbit cannot find</h2>
        {failed.length === 0 ? (
          <Empty>Every synced book resolves in BookOrbit.</Empty>
        ) : (
          <table>
            <thead><tr><th>Book</th><th>File</th><th>Document</th><th>Lookup</th></tr></thead>
            <tbody>
              {failed.map((b) => (
                <tr>
                  <td><a href={`/books/${b.bookFileId}`}>#{b.bookId}</a></td>
                  <td>{b.bookFileId}</td>
                  <td class="mono">{b.documents.join(', ')}</td>
                  <td>{b.meta === null ? 'not found' : 'request failed'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <h2>Unanchored highlights</h2>
        {clips.length === 0 ? <Empty>Every highlight is anchored in its EPUB.</Empty> : <Clips rows={clips as Clip[]} book />}
      </Page>,
    );
  });

  app.get('/covers/:bookId{[0-9]+}', async (c) => {
    const res = await bookorbit.cover(Number(c.req.param('bookId'))).catch(() => null);
    const type = res?.headers.get('content-type') ?? '';
    if (!res?.ok || !type.startsWith('image/')) return c.body(null, 404);
    return c.body(await res.arrayBuffer(), 200, { 'content-type': type, 'cache-control': 'private, max-age=3600' });
  });

  return app;
}

function Clips({ rows, book }: { rows: Clip[]; book?: boolean }) {
  return (
    <ol class="clips">
      {rows.map((r) => {
        const status = statusOf(r);
        return (
          <li class={status}>
            <div class="row">
              <Badge status={status} />
              {book && <a href={`/books/${r.book_file_id}`}>file {r.book_file_id}</a>}
              <span class="chapter">{r.chapter || 'Untitled chapter'}</span>
            </div>
            {r.text ? <blockquote>{r.text}</blockquote> : <p class="dim">No text stored.</p>}
            <p class="dim mono">
              rev {String(r.revision)} · annotation {r.annotation_id ?? 'none'} · {r.clipping_id} · created <Time value={epoch(r.created_at)} />
            </p>
          </li>
        );
      })}
    </ol>
  );
}
