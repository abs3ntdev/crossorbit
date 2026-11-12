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

export class BookOrbitError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const DEVICE_ID = 'crossorbit';

export class BookOrbit {
  constructor(
    readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  device(path: string, auth: DeviceAuth, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('x-auth-user', auth.user);
    headers.set('x-auth-key', auth.key);
    headers.set('accept', 'application/json');
    return fetch(`${this.baseUrl}/api/v1/koreader${path}`, { ...init, headers });
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

  private async api(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('x-api-key', this.apiKey);
    if (init.body) headers.set('content-type', 'application/json');
    const res = await fetch(`${this.baseUrl}/api/v1${path}`, { ...init, headers });
    if (!res.ok && res.status !== 404) throw new BookOrbitError(res.status, `${init.method ?? 'GET'} ${path} failed with ${res.status}`);
    return res;
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
    const res = await this.api(`/books/files/${fileId}/serve`);
    if (res.status === 404) throw new BookOrbitError(404, 'Book file not found');
    return new Uint8Array(await res.arrayBuffer());
  }
}
