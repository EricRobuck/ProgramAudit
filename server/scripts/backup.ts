/**
 * Logical backup / restore of ProgramAudit data.
 *   npm run backup -w server -- <out.json>
 *   npm run restore -w server -- <in.json>     (target DATABASE_URL must be empty + migrated)
 */
import fs from 'node:fs';
import { closeDb, db } from '../src/db.js';
import { getConfig } from '../src/config.js';
import { createBackup, restoreBackup, type BackupFile } from '../src/lib/backup.js';

const [cmd, file] = process.argv.slice(2);
const url = new URL(getConfig().DATABASE_URL);
if (!/programaudit/i.test(url.pathname)) {
  console.error('Refusing: database name must contain "programaudit".');
  process.exit(1);
}
try {
  if (cmd === 'backup' && file) {
    const b = await createBackup(db());
    fs.writeFileSync(file, JSON.stringify(b), { mode: 0o600 });
    console.log(`Wrote ${file}:`, Object.fromEntries(Object.entries(b.tables).map(([t, r]) => [t, r.length])));
  } else if (cmd === 'restore' && file) {
    await db().migrate.latest();
    const counts = await restoreBackup(db(), JSON.parse(fs.readFileSync(file, 'utf8')) as BackupFile);
    console.log('Restored:', counts);
  } else {
    console.error('Usage: backup.ts backup|restore <file.json>');
    process.exitCode = 1;
  }
} finally {
  await closeDb();
}
