import { operationOf, upstreamDuration, upstreamRequests } from './metrics.js';

export interface DeviceAuth {
  user: string;
  key: string;
}

export interface Annotation {
  id: number;
  bookId: number;
  cfi: string | null;
  text: string;
  chapterTitle: string | null;
  createdAt: string;
  highlightedAt?: string;
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

const DEVICE_ID = 'crossorbit';

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

  async resolve(document: string, auth: DeviceAuth): Promise<{ bookId: number; bookFileId: number } | null> {
    const res = await this.device('/plugin/match-check', auth, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: DEVICE_ID, deviceModel: 'CrossPoint', pluginVersion: '1.0.0', hashes: [document] }),
    });
    if (res.status === 401) throw new BookOrbitError(401, 'Unauthorized');
    if (!res.ok) throw new BookOrbitError(res.status, `match-check failed with ${res.status}`);
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
    if (!res.ok && res.status !== 404) throw new BookOrbitError(res.status, `${init.method ?? 'GET'} ${path} failed with ${res.status}`);
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

  async listAnnotations(bookId: number, bookFileId: number): Promise<Annotation[]> {
    const res = await this.api(`/books/${bookId}/annotations?readerFileId=${bookFileId}`);
    if (res.status === 404) return [];
    const body = (await res.json()) as Annotation[] | { items: Annotation[] };
    return Array.isArray(body) ? body : body.items;
  }

  async createAnnotation(bookId: number, body: { cfi: string; text: string; chapterTitle: string | null; bookFileId: number }): Promise<Annotation> {
    const res = await this.api(`/books/${bookId}/annotations`, { method: 'POST', body: JSON.stringify(body) });
    if (res.status === 404) throw new BookOrbitError(404, 'Book not found');
    return (await res.json()) as Annotation;
  }

  async deleteAnnotation(bookId: number, annotationId: number): Promise<void> {
    await this.api(`/books/${bookId}/annotations/${annotationId}`, { method: 'DELETE' });
  }

  async downloadFile(fileId: number): Promise<Uint8Array> {
    const res = await this.api(`/books/files/${fileId}/serve`, {}, this.timeouts.download);
    if (res.status === 404) throw new BookOrbitError(404, 'Book file not found');
    return new Uint8Array(await res.arrayBuffer());
  }
}
