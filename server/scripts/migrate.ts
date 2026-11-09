import { closeDb, db } from '../src/db.js';
import { getConfig } from '../src/config.js';

const cmd = process.argv[2] ?? 'latest';
const url = new URL(getConfig().DATABASE_URL);
console.log(`Database: ${url.hostname}:${url.port}${url.pathname} (user ${url.username})`);
if (!/programaudit/i.test(url.pathname)) {
  console.error('Refusing to migrate: database name must contain "programaudit" to guard against touching another application’s database.');
  process.exit(1);
}

try {
  if (cmd === 'latest') {
    const [batch, files] = await db().migrate.latest();
    console.log(files.length ? `Batch ${batch}: ${files.join(', ')}` : 'Already up to date');
  } else if (cmd === 'rollback') {
    const [batch, files] = await db().migrate.rollback();
    console.log(files.length ? `Rolled back batch ${batch}: ${files.join(', ')}` : 'Nothing to roll back');
  } else if (cmd === 'status') {
    const [done, pending] = await db().migrate.list();
    console.log('Completed:', done.map((d: { name: string }) => d.name));
    console.log('Pending:', pending.map((p: { file: string }) => p.file));
  } else {
    console.error(`Unknown command ${cmd}`);
    process.exitCode = 1;
  }
} finally {
  await closeDb();
}
