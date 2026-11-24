import {
  type AckDeleted, type AnnotationAckApplied, type AnnotationExchangeResult, type BookmarkAckApplied, type BookmarkExchangeResult, DEVICE_MODEL,
  exchangeDeviceId, type ExchangeKey, type ExchangeOutcome, type KoAnnotation, type KoBookmark, koDatetime, PLUGIN_VERSION,
} from './exchange.js';
import { operationOf, upstreamDuration, upstreamRequests } from './metrics.js';

export interface DeviceAuth {
  user: string;
  key: string;
}

export interface BookMeta {
  title: string | null;
  authors: string[];
}

export class BookOrbitError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Optional title and author the device reported, sent with match-check so BookOrbit can list and suggest unmatched books. */
export interface DocumentHint {
  title: string | null;
  authors: string | null;
}

const DEVICE_ID = 'crossorbit';
const MD5_RE = /^[0-9a-f]{32}$/i;
const AUTH_TTL_MS = 60_000;
const AUTH_CACHE_MAX = 1000;

/** BookOrbit's error message, if the body carries one. */
async function upstreamMessage(res: Response): Promise<string | null> {
  const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
  const message = Array.isArray(body?.message) ? body.message.join(', ') : body?.message;
  return typeof message === 'string' && message ? message : null;
}

async function failure(res: Response, what: string): Promise<BookOrbitError> {
  const message = await upstreamMessage(res);
  return new BookOrbitError(res.status, `${what} failed with ${res.status}${message ? `: ${message}` : ''}`);
}

async function timedFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const operation = operationOf(new URL(url).pathname);
  const end = upstreamDuration.startTimer({ operation });
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    upstreamRequests.inc({ operation, status: String(res.status) });
    return res;
  } catch (error) {
    upstreamRequests.inc({ operation, status: 'error' });
    throw error;
  } finally {
    end();
  }
}

export class BookOrbit {
  private readonly verified = new Map<string, number>();

  constructor(
    readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeouts = { request: 30_000, download: 120_000 },
  ) {}

  device(path: string, auth: DeviceAuth, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('x-auth-user', auth.user);
    headers.set('x-auth-key', auth.key);
    headers.set('accept', 'application/json');
    return timedFetch(`${this.baseUrl}/api/v1/koreader${path}`, { ...init, headers }, this.timeouts.request);
  }

  /** Checks device credentials, remembering a success for a minute so paged syncs do not re-check every page. */
  async checkDevice(auth: DeviceAuth): Promise<void> {
    const key = `${auth.user}\0${auth.key}`;
    const expires = this.verified.get(key);
    if (expires && expires > Date.now()) return;
    const res = await this.device('/users/auth', auth);
    if (res.status === 401) {
      this.verified.delete(key);
      throw new BookOrbitError(401, 'Unauthorized');
    }
    if (!res.ok) throw await failure(res, 'device auth');
    if (this.verified.size >= AUTH_CACHE_MAX) this.verified.clear();
    this.verified.set(key, Date.now() + AUTH_TTL_MS);
  }

  /** Forgets cached credentials, e.g. after BookOrbit rejected them on another route. */
  forgetDevice(auth: DeviceAuth): void {
    this.verified.delete(`${auth.user}\0${auth.key}`);
  }

  async resolve(document: string, auth: DeviceAuth, hint?: DocumentHint | null): Promise<{ bookId: number; bookFileId: number } | null> {
    // BookOrbit only matches MD5 document hashes and rejects anything else with 400.
    if (!MD5_RE.test(document)) {
      await this.checkDevice(auth);
      return null;
    }
    const hash = document.toLowerCase();
    const books = hint && (hint.title || hint.authors)
      ? [{ hash, source: 'current_file', ...(hint.title ? { title: hint.title.slice(0, 500) } : {}), ...(hint.authors ? { authors: hint.authors.slice(0, 1000) } : {}) }]
      : undefined;
    const res = await this.device('/plugin/match-check', auth, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: DEVICE_ID, deviceModel: 'CrossPoint', pluginVersion: '1.0.0', hashes: [hash], ...(books ? { books } : {}) }),
    });
    if (res.status === 401) throw new BookOrbitError(401, 'Unauthorized');
    if (!res.ok) throw await failure(res, 'match-check');
    const body = (await res.json()) as { matches?: { hash: string; bookId: number; bookFileId: number }[] };
    const match = body.matches?.find((m) => m.hash.toLowerCase() === document.toLowerCase());
    return match ? { bookId: match.bookId, bookFileId: match.bookFileId } : null;
  }

  async ping(): Promise<boolean> {
    try {
      const res = await timedFetch(`${this.baseUrl}/api/v1/auth/me`, { headers: { 'x-api-key': this.apiKey } }, this.timeouts.request);
      return res.ok;
    } catch {
      return false;
    }
  }

  private async api(path: string, init: RequestInit = {}, timeoutMs = this.timeouts.request): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('x-api-key', this.apiKey);
    if (init.body) headers.set('content-type', 'application/json');
    const res = await timedFetch(`${this.baseUrl}/api/v1${path}`, { ...init, headers }, timeoutMs);
    if (!res.ok && res.status !== 404) throw await failure(res, `${init.method ?? 'GET'} ${path}`);
    return res;
  }

  async getBook(bookId: number): Promise<BookMeta | null> {
    const res = await this.api(`/books/${bookId}`);
    if (res.status === 404) return null;
    const body = (await res.json()) as { title: string | null; authors?: { name: string }[] };
    return { title: body.title, authors: (body.authors ?? []).map((a) => a.name) };
  }

  cover(bookId: number): Promise<Response> {
    return timedFetch(`${this.baseUrl}/api/v1/books/${bookId}/thumbnail`, { headers: { 'x-api-key': this.apiKey } }, this.timeouts.request);
  }

  /** POSTs to a KOReader plugin route with the device credentials, as KoreaderAuthGuard expects. */
  private async plugin<T>(path: string, auth: DeviceAuth, body: Record<string, unknown>): Promise<T> {
    const res = await this.device(`/plugin/${path}`, auth, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: exchangeDeviceId(auth.user), deviceModel: DEVICE_MODEL, pluginVersion: PLUGIN_VERSION, deviceTime: koDatetime(Math.floor(Date.now() / 1000)), ...body }),
    });
    if (res.status === 401) {
      this.forgetDevice(auth);
      throw new BookOrbitError(401, 'Unauthorized');
    }
    if (!res.ok) throw await failure(res, path);
    return (await res.json()) as T;
  }

  // crossorbit's database is a durable sidecar: a sparse key list is real deletions, not a lost copy.
  exchangeAnnotations(auth: DeviceAuth, book: { hash: string; keys: ExchangeKey[]; keysComplete: boolean; changes: KoAnnotation[] }) {
    return this.plugin<ExchangeOutcome<AnnotationExchangeResult>>('annotations/exchange', auth, { books: [{ ...book, sidecarState: 'known' }] });
  }

  ackAnnotations(auth: DeviceAuth, book: { hash: string; applied: AnnotationAckApplied[]; deleted: AckDeleted[] }) {
    return this.plugin<ExchangeOutcome<{ hash: string; acked: number }>>('annotations/exchange-ack', auth, { books: [book] });
  }

  exchangeBookmarks(auth: DeviceAuth, book: { hash: string; keys: ExchangeKey[]; keysComplete: boolean; changes: KoBookmark[] }) {
    return this.plugin<ExchangeOutcome<BookmarkExchangeResult>>('bookmarks/exchange', auth, { books: [{ ...book, sidecarState: 'known' }] });
  }

  ackBookmarks(auth: DeviceAuth, book: { hash: string; applied: BookmarkAckApplied[]; deleted: AckDeleted[] }) {
    return this.plugin<ExchangeOutcome<{ hash: string; acked: number }>>('bookmarks/exchange-ack', auth, { books: [book] });
  }

  /** Uploads a reading session. BookOrbit dedupes on sessionId so retries are safe. */
  async saveSession(fileId: number, body: { sessionId: string; startedAt: string; endedAt: string; durationSeconds: number }): Promise<void> {
    const res = await this.api(`/books/files/${fileId}/sessions`, { method: 'POST', body: JSON.stringify(body) });
    if (res.status === 404) throw new BookOrbitError(404, 'Book file not found');
  }

  async downloadFile(fileId: number): Promise<Uint8Array> {
    const res = await this.api(`/books/files/${fileId}/serve`, {}, this.timeouts.download);
    if (res.status === 404) throw new BookOrbitError(404, 'Book file not found');
    return new Uint8Array(await res.arrayBuffer());
  }
}
