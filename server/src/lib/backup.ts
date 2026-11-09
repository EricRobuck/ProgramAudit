import type { Knex } from 'knex';

/**
 * Application-level logical backup of all ProgramAudit data, including
 * narratives, revision history and immutable report snapshots. Complements
 * (does not replace) pg_dump in production. Sessions are excluded.
 */
export const BACKUP_TABLES = [
  'users',
  'curricula',
  'majors',
  'reviews',
  'review_access',
  'tasks',
  'response_revisions',
  'report_snapshots',
  'activity_log',
] as const;

const JSON_COLUMNS: Record<string, string[]> = {
  report_snapshots: ['options', 'content', 'source_revisions'],
  activity_log: ['details'],
};

export interface BackupFile {
  format: 'programaudit-backup';
  version: 1;
  createdAt: string;
  migration: string | null;
  tables: Record<string, Record<string, unknown>[]>;
}

export async function createBackup(k: Knex): Promise<BackupFile> {
  return k.transaction(
    async (trx) => {
      const tables: BackupFile['tables'] = {};
      for (const t of BACKUP_TABLES) tables[t] = await trx(t).select('*').orderBy(t === 'review_access' ? 'review_id' : 'id');
      const m = await trx('programaudit_migrations').orderBy('id', 'desc').first().catch(() => null);
      return { format: 'programaudit-backup', version: 1, createdAt: new Date().toISOString(), migration: m?.name ?? null, tables };
    },
    { isolationLevel: 'repeatable read', readOnly: true } as Knex.TransactionConfig,
  );
}

/** Restores into an EMPTY, fully migrated ProgramAudit database. */
export async function restoreBackup(k: Knex, backup: BackupFile): Promise<Record<string, number>> {
  if (backup.format !== 'programaudit-backup' || backup.version !== 1) throw new Error('Not a ProgramAudit backup file');
  return k.transaction(async (trx) => {
    for (const t of BACKUP_TABLES) {
      const r = await trx(t).count({ n: '*' }).first();
      if (Number(r?.n) > 0) throw new Error(`Target table ${t} is not empty; restore only into an empty database`);
    }
    const counts: Record<string, number> = {};
    for (const t of BACKUP_TABLES) {
      let rows = backup.tables[t] ?? [];
      if (t === 'tasks') rows = parentsFirst(rows);
      const jsonCols = JSON_COLUMNS[t] ?? [];
      const prepared = rows.map((r) => {
        const o = { ...r };
        for (const c of jsonCols) if (o[c] !== null && o[c] !== undefined) o[c] = JSON.stringify(o[c]);
        return o;
      });
      for (let i = 0; i < prepared.length; i += 500) await trx(t).insert(prepared.slice(i, i + 500));
      counts[t] = rows.length;
      if (t !== 'review_access') {
        await trx.raw(`select setval(pg_get_serial_sequence(?, 'id'), coalesce((select max(id) from ??), 0) + 1, false)`, [t, t]);
      }
    }
    return counts;
  });
}

function parentsFirst(rows: Record<string, unknown>[]) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  const visit = (r: Record<string, unknown>) => {
    if (seen.has(r.id)) return;
    if (r.parent_id && byId.has(r.parent_id)) visit(byId.get(r.parent_id)!);
    seen.add(r.id);
    out.push(r);
  };
  rows.forEach(visit);
  return out;
}
