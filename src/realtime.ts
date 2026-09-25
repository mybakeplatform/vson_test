/**
 * Realtime: database change -> NOTIFY -> server fan-out -> client re-reads
 * authoritative state over HTTP.
 *
 * The SSE frame carries only a pointer (event id, type, entity). It is NOT
 * the data, and it is NOT the database: clients treat it as "go re-read".
 */
import pg from 'pg';
import type { Response } from 'express';
import { config } from './config.js';
import { connectionSettings } from './db.js';

export interface ChangeNotice {
  event_id: number;
  bakery_id: string;
  type: string;
  entity_type: string;
  entity_id: string | null;
  created_at: string;
}

interface Subscriber {
  id: number;
  bakeryId: string;
  userId: string;
  res: Response;
}

const subscribers = new Map<number, Subscriber>();
let nextSubscriberId = 1;
let listenClient: pg.Client | null = null;
let stopped = false;

export function subscribe(bakeryId: string, userId: string, res: Response): () => void {
  const id = nextSubscriberId++;
  subscribers.set(id, { id, bakeryId, userId, res });
  return () => subscribers.delete(id);
}

export function subscriberCount(bakeryId?: string): number {
  if (!bakeryId) return subscribers.size;
  let n = 0;
  for (const s of subscribers.values()) if (s.bakeryId === bakeryId) n++;
  return n;
}

function sseWrite(res: Response, event: string, data: unknown, id?: number) {
  if (id !== undefined) res.write(`id: ${id}\n`);
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Fan out to subscribers of THAT tenant only. This is the server-side half of
 * the cross-tenant isolation test: a notice for bakery B is never written to
 * a socket opened for bakery A.
 */
function dispatch(notice: ChangeNotice) {
  for (const sub of subscribers.values()) {
    if (sub.bakeryId !== notice.bakery_id) continue;
    try {
      sseWrite(sub.res, 'change', notice, notice.event_id);
    } catch {
      subscribers.delete(sub.id);
    }
  }
}

export function heartbeat() {
  for (const sub of subscribers.values()) {
    try {
      sub.res.write(`: keepalive ${Date.now()}\n\n`);
    } catch {
      subscribers.delete(sub.id);
    }
  }
}

async function connectListener(): Promise<void> {
  if (stopped) return;
  const client = new pg.Client(connectionSettings(config.databaseUrl));
  client.on('notification', (msg) => {
    if (msg.channel !== 'mybake_events' || !msg.payload) return;
    try {
      dispatch(JSON.parse(msg.payload) as ChangeNotice);
    } catch (err) {
      console.error('[realtime] bad notification payload', err);
    }
  });
  client.on('error', (err) => {
    console.error('[realtime] listener error, reconnecting:', err.message);
    listenClient = null;
    setTimeout(() => void connectListener(), 1000);
  });
  await client.connect();
  await client.query('LISTEN mybake_events');
  listenClient = client;
  console.log('[realtime] listening on mybake_events');
}

let heartbeatTimer: NodeJS.Timeout | null = null;

export async function startRealtime(): Promise<void> {
  stopped = false;
  await connectListener();
  heartbeatTimer = setInterval(heartbeat, 20_000);
  heartbeatTimer.unref?.();
}

export async function stopRealtime(): Promise<void> {
  stopped = true;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  for (const sub of subscribers.values()) {
    try {
      sub.res.end();
    } catch {
      /* already closed */
    }
  }
  subscribers.clear();
  if (listenClient) {
    await listenClient.end().catch(() => undefined);
    listenClient = null;
  }
}

export function isListening(): boolean {
  return listenClient !== null;
}

export { sseWrite };
