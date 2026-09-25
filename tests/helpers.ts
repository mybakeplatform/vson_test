/**
 * Test harness: boots the real Express app on an ephemeral port against the
 * real database from DATABASE_URL, and talks to it over real HTTP.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { migrateUp } from '../src/cli/migrate.js';
import { seed } from '../src/cli/seed.js';
import { config } from '../src/config.js';
import { closePool } from '../src/db.js';
import { startRealtime, stopRealtime } from '../src/realtime.js';

export interface Harness {
  baseUrl: string;
  stop: () => Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  await migrateUp();
  await seed();
  await startRealtime();

  const app = createApp();
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  // The probe endpoint calls back into the API; point it at this instance.
  (config as { selfUrl: string }).selfUrl = baseUrl;

  return {
    baseUrl,
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await stopRealtime();
      await closePool();
    },
  };
}

export interface Session {
  token: string;
  bakeryId: string;
  bakeryName: string;
  userId: string;
}

export class Client {
  constructor(
    readonly baseUrl: string,
    public session: Session | null = null,
  ) {}

  async request(
    path: string,
    options: { method?: string; body?: unknown; bakeryId?: string; idempotencyKey?: string } = {},
  ): Promise<{ status: number; body: any; headers: Headers }> {
    const headers: Record<string, string> = {};
    if (this.session) headers.Authorization = `Bearer ${this.session.token}`;
    const bakeryId = options.bakeryId ?? this.session?.bakeryId;
    if (bakeryId) headers['X-Bakery-Id'] = bakeryId;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

    const response = await fetch(`${this.baseUrl}/api${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : null,
      headers: response.headers,
    };
  }

  /** Throwing variant for steps that must succeed. */
  async must(path: string, options: Parameters<Client['request']>[1] = {}) {
    const result = await this.request(path, options);
    if (result.status >= 400) {
      throw new Error(`${options.method ?? 'GET'} ${path} -> ${result.status}: ${JSON.stringify(result.body)}`);
    }
    return result.body;
  }

  async login(email: string, password = config.seedPassword): Promise<Session> {
    const response = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!response.ok) throw new Error(`login failed for ${email}: ${response.status}`);
    const body = (await response.json()) as {
      token: string;
      user: { userId: string; memberships: { bakeryId: string; bakeryName: string }[] };
    };
    this.session = {
      token: body.token,
      userId: body.user.userId,
      bakeryId: body.user.memberships[0]!.bakeryId,
      bakeryName: body.user.memberships[0]!.bakeryName,
    };
    return this.session;
  }
}

/**
 * Minimal SSE reader. Collects `change` frames until the deadline, which is
 * how the tests observe realtime without a browser.
 */
export async function collectSseEvents(
  baseUrl: string,
  token: string,
  bakeryId: string,
  durationMs: number,
  onEvent?: (event: { event: string; data: any }) => void,
): Promise<{ event: string; data: any }[]> {
  const controller = new AbortController();
  const response = await fetch(
    `${baseUrl}/api/realtime/stream?access_token=${token}&bakery_id=${bakeryId}`,
    { signal: controller.signal },
  );
  if (!response.body) throw new Error('no SSE body');

  const events: { event: string; data: any }[] = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let split: number;
        while ((split = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const name = /^event: (.*)$/m.exec(frame)?.[1];
          const data = /^data: (.*)$/m.exec(frame)?.[1];
          if (name && data) {
            const parsed = { event: name, data: JSON.parse(data) };
            events.push(parsed);
            onEvent?.(parsed);
          }
        }
      }
    } catch {
      /* aborted */
    }
  })();

  await new Promise((resolve) => setTimeout(resolve, durationMs));
  controller.abort();
  await pump;
  return events;
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
