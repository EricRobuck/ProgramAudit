import knexFactory from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db, migrationConfig } from '../src/db.js';
import { getConfig } from '../src/config.js';
import { createBackup, restoreBackup } from '../src/lib/backup.js';
import { addTask, complete, createUser, login, resetDb, save, scaffoldReview } from './helpers.js';

const RESTORE_DB = 'programaudit_restore_test';

beforeAll(async () => {
  await resetDb();
});
afterAll(async () => closeDb());

describe('AT-18: backup and restore into an isolated database', () => {
  it('recovers narratives, revision history and report snapshots', async () => {
    const a = await createUser('admin', 'Backup Admin');
    const c = await createUser('coordinator', 'Backup Coord');
    const admin = await login(a.email);
    const coord = await login(c.email);
    const { review } = await scaffoldReview(admin, coord);
    const parent = await addTask(coord, review.id, 'past', 'Parent');
    const child = await addTask(coord, review.id, 'past', 'Child', parent.id);
    // Move the parent under a later-created task so child ids precede parents.
    const later = await addTask(coord, review.id, 'past', 'Later container');
    await coord.post(`/api/tasks/${parent.id}/move`, { parentId: later.id });
    await save(coord, child.id, '<p>Version one</p>');
    await save(coord, child.id, '<p>Version two</p>');
    await complete(coord, child.id);
    const snap = (await coord.post(`/api/reviews/${review.id}/reports`, { mode: 'completed' })).body.snapshot;

    const backup = JSON.parse(JSON.stringify(await createBackup(db())));

    // Create an isolated, empty database for the restore.
    const base = new URL(getConfig().DATABASE_URL);
    const adminConn = knexFactory({ client: 'pg', connection: { ...connOf(base), database: 'postgres' } });
    await adminConn.raw(`drop database if exists ${RESTORE_DB}`);
    await adminConn.raw(`create database ${RESTORE_DB}`);
    const target = knexFactory({ client: 'pg', connection: { ...connOf(base), database: RESTORE_DB }, migrations: migrationConfig() });
    try {
      await target.migrate.latest();
      const counts = await restoreBackup(target, backup);
      expect(counts.response_revisions).toBe(2);
      const revs = await target('response_revisions').where({ task_id: child.id }).orderBy('revision_no');
      expect(revs.map((r) => r.content_html)).toEqual(['<p>Version one</p>', '<p>Version two</p>']);
      const restoredSnap = await target('report_snapshots').where({ id: snap.id }).first();
      expect(restoredSnap.content).toEqual(snap.content);
      const restoredChild = await target('tasks').where({ id: child.id }).first();
      expect(restoredChild).toMatchObject({ status: 'complete', parent_id: parent.id, completed_revision_no: 2 });
      // Sequences continue after restored ids.
      const [newCur] = await target('curricula').insert({ name: 'After restore' }).returning('id');
      expect(newCur.id).toBeGreaterThan(Math.max(...backup.tables.curricula.map((x: any) => x.id)));
      // Restoring again into a non-empty database is refused.
      await expect(restoreBackup(target, backup)).rejects.toThrow(/not empty/);
    } finally {
      await target.destroy();
      await adminConn.raw(`drop database if exists ${RESTORE_DB}`);
      await adminConn.destroy();
    }
  });
});

function connOf(u: URL) {
  return { host: u.hostname, port: Number(u.port || 5432), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
}
