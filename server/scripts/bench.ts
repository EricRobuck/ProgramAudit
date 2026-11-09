/**
 * Development benchmark (spec §11): one review with 1,000 tasks across Past,
 * Present and Future (up to 5 levels deep), measuring common operations under
 * light load. Runs in-process against the TEST database, which it resets.
 *   npm run bench -w server
 */
process.env.NODE_ENV = 'test';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { closeDb, db } from '../src/db.js';
import { addTask, createUser, login, resetDb, save, scaffoldReview } from '../test/helpers.js';
import { buildForest, filterTree } from '../../client/src/util.js';

const N = 1000;

async function time<T>(label: string, runs: number, fn: () => Promise<T>) {
  const samples: number[] = [];
  let last: T | undefined;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    last = await fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))];
  console.log(`${label.padEnd(48)} median ${median.toFixed(1).padStart(7)} ms   p95 ${p95.toFixed(1).padStart(7)} ms   (n=${runs})`);
  return last as T;
}

await resetDb();
const a = await createUser('admin', 'Bench Admin');
const c = await createUser('coordinator', 'Bench Coord');
const p = await createUser('professor', 'Bench Prof');
const admin = await login(a.email);
const coord = await login(c.email);
const prof = await login(p.email);
const { review } = await scaffoldReview(admin, coord);

console.log(`Creating ${N} tasks…`);
const t0 = performance.now();
const ids: number[] = [];
const sections = ['past', 'present', 'future'];
for (let i = 0; i < N; i++) {
  const section = sections[i % 3];
  // Every 5th task is top-level; others nest under a recent task in the same section, up to depth 5.
  let parent: number | null = null;
  if (i % 5 !== 0 && i >= 3) {
    const candidate = ids[i - 3];
    const depth = Number((await db().raw('with recursive a as (select id,parent_id,1 d from tasks where id=? union all select t.id,t.parent_id,a.d+1 from tasks t join a on t.id=a.parent_id) select max(d) d from a', [candidate])).rows[0].d);
    parent = depth < 5 ? candidate : null;
  }
  ids.push((await addTask(coord, review.id, section, `Task ${i + 1} about program outcomes`, parent)).id);
}
console.log(`  created in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
for (let i = 0; i < N; i += 4) await coord.put(`/api/tasks/${ids[i]}/assignee`, { assigneeId: p.id });
const para = '<p>' + 'Assessment evidence shows steady improvement in student outcomes across the program. '.repeat(8) + '</p>';
for (let i = 0; i < N; i += 2) await save(coord, ids[i], para + para, 0);
for (let i = 0; i < N; i += 6) await coord.post(`/api/tasks/${ids[i]}/complete`, { revisionNo: 1 });

console.log(`\nEnvironment: ${os.cpus()[0].model}, ${os.cpus().length} cores, ${(os.totalmem() / 2 ** 30).toFixed(0)} GB RAM, Node ${process.version}, ${os.platform()} ${os.release()}`);
console.log('Database: local PostgreSQL (embedded-postgres), same machine; app in-process via supertest\n');

const tree = await time('GET tree (1,000 tasks)', 20, async () => (await coord.get(`/api/reviews/${review.id}/tree`)).body.tasks);
await time('Client: build forest + progress (1,000)', 50, async () => buildForest(tree));
const forest = buildForest(tree);
await time('Client: filter by professor w/ ancestors', 50, async () => {
  for (const s of ['past', 'present', 'future'] as const) filterTree(forest[s], (t) => t.assigneeId === p.id);
});
await time('GET search (title + narrative text)', 20, async () => coord.get(`/api/reviews/${review.id}/search?q=improvement`));
await time('GET task detail', 30, async () => prof.get(`/api/tasks/${ids[4]}`));
let rev = (await prof.get(`/api/tasks/${ids[4]}`)).body.task.currentRevisionNo;
await time('PUT response (save new revision)', 30, async () => {
  const r = await prof.put(`/api/tasks/${ids[4]}/response`, { html: `<p>Revision ${rev + 1}</p>` + para, baseRevisionNo: rev });
  rev = r.body.response.revisionNo;
});
await time('GET my-tasks (250 assigned)', 10, async () => prof.get('/api/my-tasks'));
await time('GET report preview (working)', 5, async () => coord.get(`/api/reviews/${review.id}/report-preview?mode=working`));
const snap = await time('POST report snapshot (working)', 3, async () => (await coord.post(`/api/reviews/${review.id}/reports`, { mode: 'working' })).body.snapshot);
await time('Download DOCX (1,000-task snapshot)', 3, async () => coord.get(`/api/reports/${snap.id}/download?format=docx`));
await time('Download PDF (1,000-task snapshot)', 3, async () => coord.get(`/api/reports/${snap.id}/download?format=pdf`));

await closeDb();
process.exit(0);
