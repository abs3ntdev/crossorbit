import { createHash } from 'node:crypto';

/** Exchange wire types for BookOrbit's KOReader plugin endpoints (server/src/modules/koreader/dto). */

export const PLUGIN_VERSION = '2.4.2';
export const DEVICE_MODEL = 'CrossPoint';
export const EXCHANGE_MAX_CHANGES = 50;
export const EXCHANGE_MAX_KEYS = 5000;
export const BOOKMARK_MAX_KEYS = 500;
export const MAX_ROUNDS = 20;

export interface ExchangeKey {
  k: string;
  dt: string;
}

export interface KoAnnotation {
  datetime: string;
  datetimeUpdated?: string;
  drawer: string;
  color?: string;
  text?: string;
  note?: string;
  chapter?: string;
  pageno?: number;
  posFormat: 'xpointer';
  pos0: string;
  pos1?: string;
}

export interface KoAddEntry {
  serverId: number;
  version: number;
  datetime: string;
  datetimeUpdated: string | null;
  drawer: string;
  color: string;
  text: string;
  note: string | null;
  chapter: string | null;
  posFormat: 'xpointer' | 'pdf';
  pos0: string;
  pos1: string | null;
  pageno: number | null;
}

export interface KoEditEntry {
  serverId: number;
  version: number;
  key: string;
  datetime: string | null;
  datetimeUpdated: string;
  drawer: string;
  color: string;
  text: string;
  note: string | null;
  chapter: string | null;
  pos0?: string;
  pos1?: string | null;
}

export interface KoDeleteEntry {
  serverId: number;
  key: string;
  datetime: string | null;
}

export interface AnnotationExchangeResult {
  hash: string;
  bookId: number;
  toApply: { add: KoAddEntry[]; edit: KoEditEntry[]; delete: KoDeleteEntry[] };
  more: boolean;
}

export interface ExchangeOutcome<R> {
  results: R[];
  unmatched: string[];
  positionIncompatible: string[];
}

export interface AnnotationAckApplied {
  serverId: number;
  version: number;
  status: 'applied' | 'failed';
  verified?: boolean;
  corrected?: boolean;
  pos0?: string;
  pos1?: string;
  datetimeUpdated?: string;
}

export interface AckDeleted {
  serverId: number;
  status: 'applied' | 'failed';
}

export interface KoBookmark {
  datetime: string;
  datetimeUpdated?: string;
  pos: string;
  pageno?: number;
  chapter?: string;
  note?: string;
}

export interface BookmarkAddEntry {
  serverId: number;
  pos: string;
  pageno: number | null;
  title: string;
}

export interface BookmarkExchangeResult {
  hash: string;
  bookId: number;
  toApply: { add: BookmarkAddEntry[]; delete: KoDeleteEntry[] };
  more: boolean;
}

export interface BookmarkAckApplied {
  serverId: number;
  status: 'applied' | 'failed';
  key?: string;
  datetime?: string;
  pos?: string;
}

/** md5(datetime|pos), the identity both KOReader exchanges use. */
export const koKey = (datetime: string, pos: string) => createHash('md5').update(`${datetime}|${pos}`).digest('hex');

const pad = (n: number) => String(n).padStart(2, '0');

/** KOReader datetime (device-local wall clock, here UTC) for a unix time. */
export function koDatetime(seconds: number): string {
  const d = new Date(seconds * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** Unix time for a KOReader datetime read in UTC, or null when malformed. */
export function fromKoDatetime(value: string | null | undefined): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value.replace(' ', 'T')}Z`);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/** Device id BookOrbit keeps exchange state under; one per KOReader user so every CrossPoint shares it. */
export function exchangeDeviceId(user: string): string {
  return `crossorbit-${createHash('sha256').update(user).digest('hex').slice(0, 24)}`;
}
