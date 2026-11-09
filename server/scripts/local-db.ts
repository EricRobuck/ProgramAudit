/**
 * Starts a local, loopback-only PostgreSQL server for development and tests
 * using real PostgreSQL binaries from the `embedded-postgres` package.
 * Data lives in ./.data/pg (git-ignored). Never points at a remote host.
 */
import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const port = Number(process.env.LOCAL_PG_PORT ?? 54329);
const user = process.env.LOCAL_PG_USER ?? 'programaudit';
const password = process.env.LOCAL_PG_PASSWORD ?? 'programaudit_local';
const dataDir = path.resolve(import.meta.dirname, '..', '..', '.data', 'pg');
const databases = ['programaudit_dev', 'programaudit_test'];

const fresh = !fs.existsSync(path.join(dataDir, 'PG_VERSION'));
const server = new EmbeddedPostgres({
  databaseDir: dataDir,
  user,
  password,
  port,
  persistent: true,
  postgresFlags: ['-c', 'listen_addresses=127.0.0.1'],
});

if (fresh) await server.initialise();
await server.start();

const client = new pg.Client({ host: '127.0.0.1', port, user, password, database: 'postgres' });
await client.connect();
for (const db of databases) {
  const r = await client.query('select 1 from pg_database where datname = $1', [db]);
  if (r.rowCount === 0) {
    await client.query(`create database ${db}`);
    console.log(`created database ${db}`);
  }
}
await client.end();
console.log(`Local PostgreSQL listening on 127.0.0.1:${port} (data: ${dataDir}). Ctrl+C to stop.`);

const stop = async () => {
  await server.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
