export interface Config {
  databaseUrl: string;
  port: number;
  seedPassword: string;
  corsOrigins: string[];
  /** Where the API can reach itself; the platform probes call back in here. */
  selfUrl: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value.trim();
}

const port = Number(process.env.PORT ?? 3000);

export const config: Config = {
  databaseUrl: required('DATABASE_URL'),
  port,
  seedPassword: process.env.SEED_PASSWORD?.trim() || 'test-password',
  corsOrigins: (process.env.CORS_ORIGINS ?? '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  selfUrl: process.env.SELF_URL?.trim() || `http://127.0.0.1:${port}`,
};
