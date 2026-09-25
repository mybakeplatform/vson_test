import { createApp } from './app.js';
import { migrateUp } from './cli/migrate.js';
import { config } from './config.js';
import { closePool } from './db.js';
import { startRealtime, stopRealtime } from './realtime.js';
import { seed } from './cli/seed.js';

/**
 * Boot order: migrate, seed the two tenants, open the NOTIFY listener, serve.
 *
 * Migration on boot is deliberate for this test harness so a fresh clone with
 * a DATABASE_URL comes up working. Set MIGRATE_ON_BOOT=false to run
 * `npm run migrate` as a separate deploy step instead.
 */
async function main() {
  if (process.env.MIGRATE_ON_BOOT !== 'false') {
    await migrateUp();
  }
  if (process.env.SEED_ON_BOOT !== 'false') {
    await seed();
  }
  await startRealtime();

  const app = createApp();
  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`[mybake] test console on http://0.0.0.0:${config.port}`);
  });

  const shutdown = async (signal: string) => {
    console.log(`[mybake] ${signal} received, shutting down`);
    server.close();
    await stopRealtime();
    await closePool();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[mybake] failed to start', err);
  process.exit(1);
});
