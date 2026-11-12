import { unzipSync, strFromU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import { parseDocument } from 'htmlparser2';

import type { CfiNode } from './cfi.js';

const xml = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, attributeNamePrefix: '@_' });

function toArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function normalizePath(path: string): string {
  const out: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

export class EpubBook {
  private readonly entries: Map<string, Uint8Array>;
  readonly spine: string[];

  constructor(bytes: Uint8Array) {
    const files = unzipSync(bytes);
    this.entries = new Map(Object.entries(files).map(([name, data]) => [normalizePath(name), data]));
    const container = xml.parse(this.read('META-INF/container.xml') ?? '');
    const rootfile = toArray(container?.container?.rootfiles?.rootfile)[0] as Record<string, string> | undefined;
    const opfPath = rootfile?.['@_full-path'];
    const opfText = opfPath ? this.read(opfPath) : null;
    if (!opfPath || !opfText) throw new Error('EPUB has no package document');
    const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
    const pkg = xml.parse(opfText)?.package ?? {};
    const manifest = new Map<string, string>();
    for (const item of toArray(pkg.manifest?.item) as Record<string, string>[]) {
      if (item['@_id'] && item['@_href']) manifest.set(item['@_id'], normalizePath(base + item['@_href'].split('#')[0]));
    }
    this.spine = (toArray(pkg.spine?.itemref) as Record<string, string>[])
      .map((ref) => manifest.get(ref['@_idref']))
      .filter((href): href is string => href != null);
  }

  private read(path: string): string | null {
    const clean = normalizePath(path);
    let data = this.entries.get(clean);
    if (!data) {
      let decoded = clean;
      try {
        decoded = decodeURIComponent(clean);
      } catch {}
      const lower = decoded.toLowerCase();
      data = this.entries.get(decoded) ?? [...this.entries].find(([name]) => name.toLowerCase() === lower)?.[1];
    }
    return data ? strFromU8(data) : null;
  }

  chapter(index: number): CfiNode | null {
    const href = this.spine[index];
    const source = href != null ? this.read(href) : null;
    if (source == null) return null;
    return parseDocument(source, { xmlMode: false, recognizeSelfClosing: true, lowerCaseTags: true }) as unknown as CfiNode;
  }
}

export class Lru<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly max: number) {}

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as K);
  }
}
