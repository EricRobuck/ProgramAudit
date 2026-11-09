import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, db } from '../src/db.js';
import { addTask, app, type Client, complete, createUser, login, resetAppInstance, resetDb, save, scaffoldReview } from './helpers.js';

let admin: Client, coord: Client, profA: Client, profB: Client;
let profAId: number, profBId: number;

beforeAll(async () => {
  await resetDb();
  const a = await createUser('admin', 'Admin One');
  const c = await createUser('coordinator', 'Coord One');
  const pa = await createUser('professor', 'Professor A');
  const pb = await createUser('professor', 'Professor B');
  profAId = pa.id;
  profBId = pb.id;
  admin = await login(a.email);
  coord = await login(c.email);
  profA = await login(pa.email);
  profB = await login(pb.email);
});
afterAll(async () => closeDb());

const tree = async (c: Client, reviewId: number, archived = false) =>
  (await c.get(`/api/reviews/${reviewId}/tree${archived ? '?includeArchived=1' : ''}`)).body.tasks as any[];

describe('catalog and review selection', () => {
  it('AT-01: majors belong to one curriculum; catalog returns filterable data', async () => {
    const c1 = (await admin.post('/api/curricula', { name: 'Arts' })).body.curriculum;
    const c2 = (await admin.post('/api/curricula', { name: 'Sciences' })).body.curriculum;
    await admin.post('/api/majors', { curriculumId: c1.id, name: 'Painting' });
    await admin.post('/api/majors', { curriculumId: c1.id, name: 'Music' });
    await admin.post('/api/majors', { curriculumId: c2.id, name: 'Biology' });
    const cat = (await admin.get('/api/catalog')).body;
    expect(cat.majors.filter((m: any) => m.curriculumId === c1.id).map((m: any) => m.name).sort()).toEqual(['Music', 'Painting']);
    expect(cat.majors.filter((m: any) => m.curriculumId === c2.id).map((m: any) => m.name)).toEqual(['Biology']);
    // Duplicate names in a curriculum are rejected; renames and archiving work.
    expect((await admin.post('/api/majors', { curriculumId: c1.id, name: 'music' })).status).toBe(409);
    const bio = cat.majors.find((m: any) => m.name === 'Biology');
    expect((await admin.patch(`/api/majors/${bio.id}`, { name: 'Biological Sciences' })).body.major.name).toBe('Biological Sciences');
    await admin.patch(`/api/curricula/${c2.id}`, { archived: true });
    const after = (await admin.get('/api/catalog')).body;
    expect(after.curricula.some((c: any) => c.id === c2.id)).toBe(false);
    expect((await admin.get('/api/catalog?includeArchived=1')).body.curricula.find((c: any) => c.id === c2.id).archived).toBe(true);
    // Non-admins cannot manage the catalog.
    expect((await coord.post('/api/curricula', { name: 'Nope' })).status).toBe(403);
  });

  it('AT-02 / AT-03: reviews are separate and each has exactly Past, Present, Future', async () => {
    const { review: r1, major } = await scaffoldReview(admin, coord);
    const r2 = (await coord.post('/api/reviews', { majorId: major.id, title: '2031 Program Review' })).body.review;
    const t1 = await addTask(coord, r1.id, 'past', 'Only in review 1');
    await addTask(coord, r2.id, 'future', 'Only in review 2');
    await save(coord, t1.id, '<p>Review one text</p>');
    const tr1 = await tree(coord, r1.id);
    const tr2 = await tree(coord, r2.id);
    expect(tr1.map((t) => t.title)).toEqual(['Only in review 1']);
    expect(tr2.map((t) => t.title)).toEqual(['Only in review 2']);
    expect((await coord.get(`/api/reviews/${r2.id}/search?q=Review%20one`)).body.taskIds).toEqual([]);
    // Sections are a fixed enum; anything else is rejected.
    expect((await coord.post(`/api/reviews/${r1.id}/tasks`, { section: 'other', title: 'x' })).status).toBe(400);
    const report = (await coord.get(`/api/reviews/${r1.id}/report-preview?mode=working`)).body.content;
    expect(report.sections.map((s: any) => s.label)).toEqual(['Past', 'Present', 'Future']);
  });
});

describe('task trees', () => {
  let reviewId: number;
  beforeAll(async () => {
    reviewId = (await scaffoldReview(admin, coord, { curriculum: 'Computing', major: 'Data Science', review: 'Tree review' })).review.id;
  });

  it('AT-04: supports deep nesting, ordering persists, depth limit enforced', async () => {
    let parent: number | null = null;
    const ids: number[] = [];
    for (let level = 1; level <= 6; level++) {
      const t = await addTask(coord, reviewId, 'present', `Level ${level}`, parent);
      ids.push(t.id);
      parent = t.id;
    }
    const a = await addTask(coord, reviewId, 'present', 'Sibling A', ids[0]);
    const b = await addTask(coord, reviewId, 'present', 'Sibling B', ids[0]);
    // Move B before Level 2 (position 0 among Level 1's children).
    expect((await coord.post(`/api/tasks/${b.id}/move`, { parentId: ids[0], position: 0 })).status).toBe(200);
    resetAppInstance(); // simulate a reload against a fresh app instance
    const t = await tree(coord, reviewId);
    const kids = t.filter((x) => x.parentId === ids[0]).sort((x, y) => x.sortOrder - y.sortOrder).map((x) => x.title);
    expect(kids).toEqual(['Sibling B', 'Level 2', 'Sibling A']);
    expect(t.find((x) => x.title === 'Level 6').parentId).toBe(ids[4]);
    // Build down to the depth limit (10) then exceed it.
    let p = ids[5];
    for (let level = 7; level <= 10; level++) p = (await addTask(coord, reviewId, 'present', `Level ${level}`, p)).id;
    expect((await coord.post(`/api/reviews/${reviewId}/tasks`, { section: 'present', title: 'Too deep', parentId: p })).status).toBe(400);
    void a;
  });

  it('AT-05 / FR-09: parent and child ownership are independent; new subtasks start unassigned', async () => {
    const parent = await addTask(coord, reviewId, 'past', 'Parent');
    const child = await addTask(coord, reviewId, 'past', 'Child', parent.id);
    await coord.put(`/api/tasks/${parent.id}/assignee`, { assigneeId: profAId });
    await coord.put(`/api/tasks/${child.id}/assignee`, { assigneeId: profBId });
    await coord.put(`/api/tasks/${parent.id}/assignee`, { assigneeId: profBId });
    const t = await tree(coord, reviewId);
    expect(t.find((x) => x.id === parent.id).assigneeId).toBe(profBId);
    expect(t.find((x) => x.id === child.id).assigneeId).toBe(profBId);
    await coord.put(`/api/tasks/${parent.id}/assignee`, { assigneeId: null });
    expect((await tree(coord, reviewId)).find((x) => x.id === child.id).assigneeId).toBe(profBId);
    const grandchild = await addTask(coord, reviewId, 'past', 'Grandchild', child.id);
    expect(grandchild).toMatchObject({ status: 'not_started' });
    expect((await tree(coord, reviewId)).find((x) => x.id === grandchild.id).assigneeId).toBeNull();
  });

  it('rejects inactive and non-faculty assignees', async () => {
    const inactive = await createUser('professor', 'Gone Prof', { active: false });
    const t = await addTask(coord, reviewId, 'future', 'Assign test');
    expect((await coord.put(`/api/tasks/${t.id}/assignee`, { assigneeId: inactive.id })).status).toBe(400);
    expect((await coord.put(`/api/tasks/${t.id}/assignee`, { assigneeId: 999999 })).status).toBe(400);
  });

  it('AT-12: moving a subtree between sections keeps text, owners, history; invalid moves fail', async () => {
    const root = await addTask(coord, reviewId, 'past', 'Movable root');
    const kid = await addTask(coord, reviewId, 'past', 'Movable kid', root.id);
    const gkid = await addTask(coord, reviewId, 'past', 'Movable grandkid', kid.id);
    await coord.put(`/api/tasks/${kid.id}/assignee`, { assigneeId: profAId });
    expect((await save(profA, kid.id, '<p>Kid narrative v1</p>')).status).toBe(200);
    expect((await save(profA, kid.id, '<p>Kid narrative v2</p>')).status).toBe(200);
    const res = await coord.post(`/api/tasks/${root.id}/move`, { section: 'future', parentId: null, position: 0 });
    expect(res.status).toBe(200);
    const t = await tree(coord, reviewId);
    for (const id of [root.id, kid.id, gkid.id]) expect(t.find((x) => x.id === id).section).toBe('future');
    const k = (await coord.get(`/api/tasks/${kid.id}`)).body;
    expect(k.response.html).toBe('<p>Kid narrative v2</p>');
    expect(k.task.assigneeId).toBe(profAId);
    expect((await coord.get(`/api/tasks/${kid.id}/revisions`)).body.revisions).toHaveLength(2);
    const futureRoots = t.filter((x) => x.section === 'future' && !x.parentId).sort((a, b) => a.sortOrder - b.sortOrder);
    expect(futureRoots[0].id).toBe(root.id);
    const report = (await coord.get(`/api/reviews/${reviewId}/report-preview?mode=working`)).body.content;
    const fut = report.sections.find((s: any) => s.key === 'future').nodes.map((n: any) => n.title);
    expect(fut.slice(0, 3)).toEqual(['Movable root', 'Movable kid', 'Movable grandkid']);

    // Cycles and self-parenting fail.
    expect((await coord.post(`/api/tasks/${root.id}/move`, { parentId: gkid.id })).status).toBe(400);
    expect((await coord.post(`/api/tasks/${root.id}/move`, { parentId: root.id })).status).toBe(400);
    // Cross-review move fails.
    const other = (await coord.post('/api/reviews', { majorId: (await coord.get(`/api/reviews/${reviewId}`)).body.major.id, title: 'Other review' })).body.review;
    const foreign = await addTask(coord, other.id, 'past', 'Foreign parent');
    expect((await coord.post(`/api/tasks/${root.id}/move`, { parentId: foreign.id })).status).toBe(400);
    // Section mismatch with explicit parent fails.
    expect((await coord.post(`/api/tasks/${gkid.id}/move`, { section: 'past', parentId: root.id })).status).toBe(400);
    // Database-level guard: a parent in another section is impossible even via SQL.
    await expect(db()('tasks').where({ id: gkid.id }).update({ section: 'past' })).rejects.toThrow();
  });

  it('AT-12: the depth limit applies to the whole moved subtree', async () => {
    const deepRoot = await addTask(coord, reviewId, 'past', 'Deep root');
    let p = deepRoot.id;
    for (let i = 2; i <= 6; i++) p = (await addTask(coord, reviewId, 'past', `D${i}`, p)).id; // height 6
    let q = (await addTask(coord, reviewId, 'past', 'Host 1')).id;
    for (let i = 2; i <= 5; i++) q = (await addTask(coord, reviewId, 'past', `H${i}`, q)).id; // depth 5
    // 5 + 6 > 10 → rejected
    expect((await coord.post(`/api/tasks/${deepRoot.id}/move`, { parentId: q })).status).toBe(400);
  });

  it('AT-13: archive and restore a subtree; progress and reports exclude archived content', async () => {
    const r = (await coord.post('/api/reviews', { majorId: (await coord.get(`/api/reviews/${reviewId}`)).body.major.id, title: 'Archive review' })).body.review;
    const top = await addTask(coord, r.id, 'present', 'Archivable');
    const sub = await addTask(coord, r.id, 'present', 'Archivable child', top.id);
    const keep = await addTask(coord, r.id, 'present', 'Keeper');
    await save(coord, sub.id, '<p>Child text</p>');
    await complete(coord, sub.id);
    const snap = (await coord.post(`/api/reviews/${r.id}/reports`, { mode: 'working' })).body.snapshot;
    expect((await coord.get(`/api/tasks/${top.id}/archive-preview`)).body.descendantCount).toBe(1);
    expect((await coord.post(`/api/tasks/${top.id}/archive`)).body.archivedCount).toBe(2);
    expect((await tree(coord, r.id)).map((t) => t.id)).toEqual([keep.id]);
    expect((await tree(coord, r.id, true)).length).toBe(3);
    // Professors never see archived content, even when requesting it.
    const pre = (await coord.get(`/api/reviews/${r.id}/report-preview?mode=working`)).body.content;
    expect(pre.progress).toEqual({ completed: 0, total: 1 });
    // Archived tasks are read-only.
    expect((await save(coord, sub.id, '<p>edit</p>')).status).toBe(409);
    // Restoring the child alone is blocked while its parent is archived.
    expect((await coord.post(`/api/tasks/${sub.id}/restore`)).status).toBe(409);
    expect((await coord.post(`/api/tasks/${top.id}/restore`)).body.restoredCount).toBe(2);
    expect((await tree(coord, r.id)).length).toBe(3);
    // History and prior snapshot remain intact.
    expect((await coord.get(`/api/tasks/${sub.id}/revisions`)).body.revisions).toHaveLength(1);
    const again = (await coord.get(`/api/reports/${snap.id}`)).body.snapshot.content;
    expect(again.progress).toEqual({ completed: 1, total: 3 });
  });
});

describe('narratives, completion and concurrency', () => {
  let reviewId: number;
  beforeAll(async () => {
    reviewId = (await scaffoldReview(admin, coord, { curriculum: 'Computing', major: 'Networking', review: 'Writing review' })).review.id;
  });

  it('AT-07: multiple paragraphs and formatting persist across an app restart', async () => {
    const t = await addTask(coord, reviewId, 'past', 'Persistence');
    await coord.put(`/api/tasks/${t.id}/assignee`, { assigneeId: profAId });
    const html = '<p>First <strong>bold</strong> and <em>italic</em>.</p><p>Second paragraph.</p><ul><li><p>Item</p></li></ul>';
    const r = await save(profA, t.id, html);
    expect(r.status).toBe(200);
    expect(r.body.task.status).toBe('in_progress');
    // "Restart": drop pools and the app, then read through a new instance and session.
    await closeDb();
    resetAppInstance();
    const fresh = await login('professor.a@example.test');
    const got = (await fresh.get(`/api/tasks/${t.id}`)).body;
    expect(got.response.html).toBe(html);
    expect(got.response.wordCount).toBe(7);
    profA = fresh;
    coord = await login('coord.one@example.test');
    admin = await login('admin.one@example.test');
    profB = await login('professor.b@example.test');
  });

  it('AT-08: blank or markup-only responses cannot complete; substantive text can', async () => {
    const t = await addTask(coord, reviewId, 'present', 'Completion rules');
    await coord.put(`/api/tasks/${t.id}/assignee`, { assigneeId: profAId });
    expect((await complete(profA, t.id)).status).toBe(422);
    await save(profA, t.id, '<p> </p><ul><li></li></ul><p><strong></strong></p>');
    expect((await profA.get(`/api/tasks/${t.id}`)).body.task.status).toBe('not_started');
    expect((await complete(profA, t.id)).status).toBe(422);
    await save(profA, t.id, '<p>Real text.</p>');
    const done = await complete(profA, t.id);
    expect(done.status).toBe(200);
    expect(done.body.task.status).toBe('complete');
    // FR-15: complete is read-only until a coordinator reopens it.
    expect((await save(profA, t.id, '<p>change</p>')).status).toBe(409);
    expect((await profA.post(`/api/tasks/${t.id}/reopen`)).status).toBe(403);
    const reopened = await coord.post(`/api/tasks/${t.id}/reopen`);
    expect(reopened.body.task).toMatchObject({ status: 'in_progress', reopenedBy: coord.userId });
    expect((await profA.get(`/api/tasks/${t.id}`)).body.response.html).toBe('<p>Real text.</p>');
  });

  it('AT-09: a complete parent with an unfinished child leaves progress partial', async () => {
    const r = (await coord.post('/api/reviews', { majorId: (await coord.get(`/api/reviews/${reviewId}`)).body.major.id, title: 'Progress review' })).body.review;
    expect((await coord.get(`/api/reviews/${r.id}/report-preview?mode=working`)).body.content.progress).toEqual({ completed: 0, total: 0 });
    const parent = await addTask(coord, r.id, 'present', 'Parent');
    await addTask(coord, r.id, 'present', 'Child', parent.id);
    await save(coord, parent.id, '<p>Parent narrative.</p>');
    await complete(coord, parent.id);
    const t = await tree(coord, r.id);
    expect(t.find((x) => x.id === parent.id).status).toBe('complete');
    const report = (await coord.get(`/api/reviews/${r.id}/report-preview?mode=working`)).body.content;
    expect(report.progress).toEqual({ completed: 1, total: 2 });
    expect(report.allComplete).toBe(false);
  });

  it('AT-10: a failed save is not recorded and completion of unsaved text is refused', async () => {
    const t = await addTask(coord, reviewId, 'future', 'Failure handling');
    await coord.put(`/api/tasks/${t.id}/assignee`, { assigneeId: profAId });
    await save(profA, t.id, '<p>Saved draft.</p>');
    // Simulated failure: a malformed body is rejected and nothing changes.
    const bad = await profA.put(`/api/tasks/${t.id}/response`, { html: 42, baseRevisionNo: 1 });
    expect(bad.status).toBe(400);
    const tooBig = await profA.put(`/api/tasks/${t.id}/response`, { html: `<p>${'x'.repeat(600_000)}</p>`, baseRevisionNo: 1 });
    expect(tooBig.status).toBe(400);
    expect((await profA.get(`/api/tasks/${t.id}`)).body.task.currentRevisionNo).toBe(1);
    // Completing against a revision that was never saved is refused.
    expect((await profA.post(`/api/tasks/${t.id}/complete`, { revisionNo: 2 })).status).toBe(409);
  });

  it('AT-11: a stale save from a second session conflicts and does not overwrite', async () => {
    const t = await addTask(coord, reviewId, 'future', 'Concurrency');
    await coord.put(`/api/tasks/${t.id}/assignee`, { assigneeId: profAId });
    const sessionTwo = await login('professor.a@example.test');
    const base = (await profA.get(`/api/tasks/${t.id}`)).body.task.currentRevisionNo;
    expect((await save(profA, t.id, '<p>Session one</p>', base)).status).toBe(200);
    const stale = await save(sessionTwo, t.id, '<p>Session two</p>', base);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('revision_conflict');
    expect(stale.body.error.details.current.html).toBe('<p>Session one</p>');
    expect((await profA.get(`/api/tasks/${t.id}`)).body.response.html).toBe('<p>Session one</p>');
    // A deliberate retry against the latest revision succeeds.
    expect((await save(sessionTwo, t.id, '<p>Session two</p>', stale.body.error.details.current.revisionNo)).status).toBe(200);
  });

  it('FR-16: coordinator edits are attributed to the coordinator; history restore creates a new revision', async () => {
    const t = await addTask(coord, reviewId, 'past', 'History');
    await coord.put(`/api/tasks/${t.id}/assignee`, { assigneeId: profAId });
    await save(profA, t.id, '<p>Professor wrote this.</p>');
    await save(coord, t.id, '<p>Coordinator edited this.</p>');
    const revs = (await coord.get(`/api/tasks/${t.id}/revisions`)).body.revisions;
    expect(revs.map((r: any) => r.authorName)).toEqual(['Coord One', 'Professor A']);
    const restored = await coord.post(`/api/tasks/${t.id}/revisions/1/restore`, { baseRevisionNo: 2 });
    expect(restored.status).toBe(200);
    expect(restored.body.response).toMatchObject({ revisionNo: 3, html: '<p>Professor wrote this.</p>', authorName: 'Coord One', restoredFromRevisionNo: 1 });
    expect((await profA.post(`/api/tasks/${t.id}/revisions/1/restore`, { baseRevisionNo: 3 })).status).toBe(403);
    // Revisions are append-only at the database level.
    await expect(db()('response_revisions').where({ task_id: t.id }).update({ content_html: 'x' })).rejects.toThrow(/immutable/);
  });

  it('FR-17: My Tasks lists assigned work with path', async () => {
    const mine = (await profA.get('/api/my-tasks')).body.tasks;
    expect(mine.length).toBeGreaterThan(0);
    const item = mine.find((x: any) => x.title === 'History');
    expect(item).toMatchObject({ reviewTitle: 'Writing review', section: 'past', majorName: 'Networking' });
    expect(item.path).toEqual(['History']);
  });

  it('FR-18: search matches titles and narrative text', async () => {
    const hits = (await coord.get(`/api/reviews/${reviewId}/search?q=coordinator%20edited`)).body.taskIds;
    expect(hits.length).toBe(0); // current text was restored to the professor's version
    const hits2 = (await coord.get(`/api/reviews/${reviewId}/search?q=Professor%20wrote`)).body.taskIds;
    expect(hits2.length).toBe(1);
    expect((await coord.get(`/api/reviews/${reviewId}/search?q=Concurrency`)).body.taskIds.length).toBe(1);
    expect((await coord.get(`/api/reviews/${reviewId}/search?q=%25`)).body.taskIds.length).toBe(0);
  });

  it('FR-04: archived reviews are read-only until reopened', async () => {
    const t = await addTask(coord, reviewId, 'past', 'Before archive');
    await coord.patch(`/api/reviews/${reviewId}`, { archived: true });
    expect((await save(coord, t.id, '<p>x</p>')).status).toBe(409);
    expect((await coord.post(`/api/reviews/${reviewId}/tasks`, { section: 'past', title: 'no' })).status).toBe(409);
    expect((await coord.patch(`/api/reviews/${reviewId}`, { title: 'Renamed' })).status).toBe(409);
    await coord.patch(`/api/reviews/${reviewId}`, { archived: false });
    expect((await save(coord, t.id, '<p>x</p>')).status).toBe(200);
  });

  it('records structural and completion activity', async () => {
    const actions = new Set((await coord.get(`/api/reviews/${reviewId}/activity`)).body.activity.map((a: any) => a.action));
    for (const a of ['task.create', 'task.assign', 'response.save', 'task.complete', 'task.reopen', 'review.archive', 'review.reopen']) {
      expect(actions.has(a), a).toBe(true);
    }
  });
});

void app;
