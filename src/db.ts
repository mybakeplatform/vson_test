import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;

// Return DECIMAL/NUMERIC as a JS number instead of a string so confidence
// scores and cent totals compare cleanly in checks.
pg.types.setTypeParser(1700, (value) => Number(value));
// bigint (events.id, audit_log.id) -> number; ids here stay well inside 2^53.
pg.types.setTypeParser(20, (value) => Number(value));
// DATE -> plain 'YYYY-MM-DD' string. Never a JS Date: a service date is a
// calendar day, and converting it through a timezone is how "October 1"
// becomes "September 30" in someone's report.
pg.types.setTypeParser(1082, (value) => value);

/**
 * TLS handling: managed providers hand out `?sslmode=require` URLs signed by
 * their own CA. We honour the flag but do not demand a publicly rooted chain,
 * which is what every hosted Postgres in this class expects. The sslmode
 * parameter is stripped from the URL and turned into an explicit `ssl`
 * option, so the driver's own interpretation of it never surprises us.
 */
export function connectionSettings(url: string): {
  connectionString: string;
  ssl: pg.ClientConfig['ssl'];
} {
  const mode = /[?&]sslmode=([^&]+)/.exec(url)?.[1] ?? process.env.PGSSLMODE ?? '';
  const connectionString = url.replace(/([?&])sslmode=[^&]*&?/, (_m, sep: string) =>
    sep === '?' ? '?' : '&',
  ).replace(/[?&]$/, '');
  const ssl = !mode || mode === 'disable' ? undefined : { rejectUnauthorized: false };
  return { connectionString, ssl };
}

// ONE module-level pool for the whole process.
export const pool = new Pool({
  ...connectionSettings(config.databaseUrl),
  max: 8,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  console.error('[db] idle client error', err.message);
});

export type Sql = pg.PoolClient | pg.Pool;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  client: Sql = pool,
): Promise<T[]> {
  const result = await client.query<T>(sql, params as never[]);
  return result.rows;
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  client: Sql = pool,
): Promise<T | null> {
  const rows = await query<T>(sql, params, client);
  return rows[0] ?? null;
}

/** Run a function inside a transaction, rolling back on any throw. */
export async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection already gone */
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
