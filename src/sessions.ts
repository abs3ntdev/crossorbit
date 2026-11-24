import { z } from 'zod';

import { type BookOrbit, BookOrbitError, type DeviceAuth } from './bookorbit.js';
import type { ClippingService } from './clippings.js';
import { type Db, now } from './db.js';
import type { Logger } from './log.js';
import { readingSessions } from './metrics.js';
import { ProtocolError } from './protocol.js';

export const SESSION_BATCH_MAX = 20;
const RETRY_LIMIT = 50;

const sessionItem = z.object({
  session_id: z.string().min(1).max(40),
  document: z.string().regex(/^[0-9a-fA-F]{32}$/),
  started_at: z.number().int().min(0),
  ended_at: z.number().int().min(0),
  seconds: z.number().int().min(0),
  utc_offset_minutes: z.number().int().min(-720).max(840).nullish(),
}).refine((s) => s.ended_at >= s.started_at, { message: 'Invalid ended_at' });

const sessionBatch = z.object({
  device_id: z.string().max(128).nullish(),
  items: z.array(sessionItem).max(SESSION_BATCH_MAX),
});

export type SessionBatch = z.output<typeof sessionBatch>;

export function decodeSessionBatch(body: unknown): SessionBatch {
  const parsed = sessionBatch.safeParse(body);
  if (!parsed.success) throw new ProtocolError('Invalid sessions');
  return parsed.data;
}

interface StoredSession {
  session_id: string;
  document: string;
  started_at: string | number;
  ended_at: string | number;
  seconds: number;
}

export class SessionService {
  constructor(
    private readonly db: Db,
    private readonly bookorbit: BookOrbit,
    private readonly clippings: ClippingService,
    private readonly log: Logger,
  ) {}

  /** Stores every session, uploads pending ones and returns the ids to acknowledge. */
  async upload(auth: DeviceAuth, batch: SessionBatch): Promise<string[]> {
    await this.bookorbit.checkDevice(auth);
    const deviceId = batch.device_id ?? '';
    for (const item of batch.items) {
      await this.db.insertInto('reading_sessions').values({
        session_id: item.session_id,
        device_id: deviceId,
        username: auth.user,
        document: item.document.toLowerCase(),
        started_at: item.started_at,
        ended_at: item.ended_at,
        seconds: item.seconds,
        utc_offset_minutes: item.utc_offset_minutes ?? 0,
        book_file_id: null,
        status: 'pending',
      }).onConflict((oc) => oc.columns(['username', 'session_id']).doNothing()).execute();
    }
    const ids = batch.items.map((i) => i.session_id);
    // Sessions from this batch go first, then older pending ones are retried.
    const fresh = ids.length
      ? await this.db.selectFrom('reading_sessions').selectAll().where('username', '=', auth.user)
        .where('status', '=', 'pending').where('session_id', 'in', ids).execute()
      : [];
    const older = await this.db.selectFrom('reading_sessions').selectAll().where('username', '=', auth.user)
      .where('status', '=', 'pending').where('session_id', 'not in', ids.length ? ids : ['']).orderBy('started_at')
      .limit(RETRY_LIMIT).execute();
    const resolved = new Map<string, number | null>();
    for (const session of [...fresh, ...older]) await this.push(auth, session, resolved);
    return ids;
  }

  private async push(auth: DeviceAuth, session: StoredSession, resolved: Map<string, number | null>) {
    const where = (q: any) => q.where('username', '=', auth.user).where('session_id', '=', session.session_id);
    let fileId = resolved.get(session.document);
    try {
      if (fileId === undefined) {
        fileId = (await this.clippings.resolve(session.document, auth))?.bookFileId ?? null;
        resolved.set(session.document, fileId);
      }
      if (fileId == null) {
        readingSessions.inc({ outcome: 'unresolved' });
        await where(this.db.updateTable('reading_sessions').set({ attempts: (eb: any) => eb('attempts', '+', 1), last_error: 'book not found' })).execute();
        return;
      }
      await this.bookorbit.saveSession(fileId, {
        sessionId: `crosspoint:${session.session_id}`,
        startedAt: new Date(Number(session.started_at) * 1000).toISOString(),
        endedAt: new Date(Number(session.ended_at) * 1000).toISOString(),
        durationSeconds: session.seconds,
      });
      readingSessions.inc({ outcome: 'uploaded' });
      await where(this.db.updateTable('reading_sessions')
        .set({ status: 'uploaded', book_file_id: fileId, attempts: (eb: any) => eb('attempts', '+', 1), last_error: null, uploaded_at: now(this.db) }))
        .execute();
      this.log.info('reading session uploaded', { sessionId: session.session_id, bookFileId: fileId, seconds: session.seconds });
    } catch (error) {
      if (error instanceof BookOrbitError && error.status === 401) throw error;
      const message = error instanceof Error ? error.message : String(error);
      readingSessions.inc({ outcome: 'failed' });
      this.log.warn('reading session upload failed', { sessionId: session.session_id, error: message });
      await where(this.db.updateTable('reading_sessions')
        .set({ book_file_id: fileId ?? null, attempts: (eb: any) => eb('attempts', '+', 1), last_error: message.slice(0, 500) }))
        .execute();
    }
  }
}
