import knexFactory, { type Knex } from 'knex';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getConfig } from './config.js';

// Calendar dates are kept as 'YYYY-MM-DD' strings so they never shift through UTC midnight.
pg.types.setTypeParser(1082, (v: string) => v);
// bigint ids are well within JS safe range for this application.
pg.types.setTypeParser(20, (v: string) => Number(v));

let instance: Knex | undefined;

/**
 * Migrations are recorded without file extensions, so the same database works
 * with TypeScript sources (development) and compiled JavaScript (production).
 */
class ExtensionlessMigrationSource implements Knex.MigrationSource<string> {
  constructor(
    private dir: string,
    private ext: string,
  ) {}
  async getMigrations() {
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith(this.ext) && !f.endsWith('.d.ts'))
      .map((f) => f.slice(0, -this.ext.length))
      .sort();
  }
  getMigrationName(name: string) {
    return name;
  }
  async getMigration(name: string) {
    return import(pathToFileURL(path.join(this.dir, name + this.ext)).href);
  }
}

export function migrationConfig(): Knex.MigratorConfig {
  const compiled = import.meta.filename.endsWith('.js');
  return {
    migrationSource: new ExtensionlessMigrationSource(path.resolve(import.meta.dirname, '..', 'migrations'), compiled ? '.js' : '.ts'),
    tableName: 'programaudit_migrations',
  };
}

export function db(): Knex {
  if (!instance) {
    instance = knexFactory({
      client: 'pg',
      connection: getConfig().DATABASE_URL,
      pool: { min: 0, max: 10 },
      migrations: migrationConfig(),
    });
  }
  return instance;
}

export async function closeDb(): Promise<void> {
  if (instance) {
    await instance.destroy();
    instance = undefined;
  }
}
