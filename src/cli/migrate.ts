/**
 * Minimal forward-only SQL migration runner.
 *
 *   npm run migrate          apply every pending file in db/migrations
 *   npm run migrate:status   list applied / pending
 *
 * Each file runs once, inside a transaction, and is recorded in
 * schema_migrations with a sha256 of its contents. Editing an applied file is
 * reported as drift instead of being silently ignored.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, pool, query } from '../db.js';

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, '..', '..', 'db', 'migrations');

interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export function loadMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

async function ensureTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )`);
}

export async function migrateUp(): Promise<string[]> {
  await ensureTable();
  const applied = new Map(
    (await query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')).map(
      (r) => [r.name, r.checksum],
    ),
  );
  const run: string[] = [];

  for (const migration of loadMigrations()) {
    const previous = applied.get(migration.name);
    if (previous) {
      if (previous !== migration.checksum) {
        console.warn(
          `[migrate] WARNING: ${migration.name} was applied with a different checksum. ` +
            'Applied migrations must not be edited; add a new migration instead.',
        );
      }
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
        migration.name,
        migration.checksum,
      ]);
      await client.query('COMMIT');
      console.log(`[migrate] applied ${migration.name}`);
      run.push(migration.name);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`[migrate] FAILED ${migration.name}`);
      throw err;
    } finally {
      client.release();
    }
  }
  if (run.length === 0) console.log('[migrate] nothing to apply, schema is up to date');
  return run;
}

async function status(): Promise<void> {
  await ensureTable();
  const applied = new Set(
    (await query<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name),
  );
  for (const m of loadMigrations()) {
    console.log(`${applied.has(m.name) ? 'applied ' : 'PENDING '} ${m.name}`);
  }
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  const cmd = process.argv[2] ?? 'up';
  try {
    if (cmd === 'status') await status();
    else await migrateUp();
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
