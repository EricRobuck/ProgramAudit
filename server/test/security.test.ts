import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb } from '../src/db.js';
import { addTask, app, type Client, createUser, login, resetDb, save, scaffoldReview } from './helpers.js';

let admin: Client, coord: Client, coord2: Client, profA: Client, profB: Client, outsider: Client;
let ids: { profA: number; profB: number; admin: number; coord2: number };
let reviewId: number, otherReviewId: number, taskA: number, taskB: number, otherTask: number, snapshotId: number;

beforeAll(async () => {
  await resetDb();
  const a = await createUser('admin', 'Sec Admin');
  const c = await createUser('coordinator', 'Sec Coord');
  const c2 = await createUser('coordinator', 'Other Coord');
  const pa = await createUser('professor', 'Sec Prof A');
  const pb = await createUser('professor', 'Sec Prof B');
  const o = await createUser('professor', 'Outsider Prof');
  ids = { profA: pa.id, profB: pb.id, admin: a.id, coord2: c2.id };
  admin = await login(a.email);
  coord = await login(c.email);
  coord2 = await login(c2.email);
  profA = await login(pa.email);
  profB = await login(pb.email);
  outsider = await login(o.email);
  const s = await scaffoldReview(admin, coord);
  reviewId = s.review.id;
  taskA = (await addTask(coord, reviewId, 'present', 'A task')).id;
  taskB = (await addTask(coord, reviewId, 'present', 'B task')).id;
  await coord.put(`/api/tasks/${taskA}/assignee`, { assigneeId: pa.id });
  await coord.put(`/api/tasks/${taskB}/assignee`, { assigneeId: pb.id });
  await save(profB, taskB, '<p>B wrote this</p>');
  otherReviewId = (await coord2.post('/api/reviews', { majorId: s.major.id, title: 'Private review' })).body.review.id;
  otherTask = (await addTask(coord2, otherReviewId, 'past', 'Secret task')).id;
  await save(coord2, otherTask, '<p>Secret narrative</p>');
  snapshotId = (await coord2.post(`/api/reviews/${otherReviewId}/reports`, { mode: 'working' })).body.snapshot.id;
});
afterAll(async () => closeDb());

describe('authorization', () => {
  it('AT-06: professors edit only their own responses and cannot change assignments', async () => {
    expect((await save(profA, taskA, '<p>Mine</p>')).status).toBe(200);
    const res = await save(profA, taskB, '<p>Overwrite B</p>');
    expect(res.status).toBe(403);
    expect((await profA.put(`/api/tasks/${taskB}/assignee`, { assigneeId: ids.profA })).status).toBe(403);
    expect((await profA.put(`/api/tasks/${taskA}/assignee`, { assigneeId: null })).status).toBe(403);
    expect((await profA.post(`/api/tasks/${taskB}/complete`, { revisionNo: 1 })).status).toBe(403);
    expect((await profA.patch(`/api/tasks/${taskA}`, { title: 'x' })).status).toBe(403);
    expect((await profA.post(`/api/reviews/${reviewId}/tasks`, { section: 'past', title: 'x' })).status).toBe(403);
    expect((await profA.post(`/api/tasks/${taskA}/move`, { section: 'past', parentId: null })).status).toBe(403);
    expect((await profA.post(`/api/tasks/${taskA}/archive`)).status).toBe(403);
    expect((await profA.post(`/api/reviews/${reviewId}/reports`, { mode: 'working' })).status).toBe(403);
    expect((await profB.get(`/api/tasks/${taskB}`)).body.response.html).toBe('<p>B wrote this</p>');
    // Professors may read the tree and preview reports for context.
    expect((await profA.get(`/api/reviews/${reviewId}/tree`)).status).toBe(200);
    expect((await profA.get(`/api/reviews/${reviewId}/report-preview?mode=working`)).status).toBe(200);
  });

  it('reassignment changes who may edit from then on, preserving writing', async () => {
    await coord.put(`/api/tasks/${taskB}/assignee`, { assigneeId: ids.profA });
    expect((await save(profB, taskB, '<p>B again</p>')).status).toBe(403);
    expect((await profA.get(`/api/tasks/${taskB}`)).body.response.html).toBe('<p>B wrote this</p>');
    expect((await save(profA, taskB, '<p>A continues</p>')).status).toBe(200);
  });

  it('AT-17: guessed review, task, report and export identifiers are not readable', async () => {
    for (const c of [profA, outsider, coord]) {
      expect((await c.get(`/api/reviews/${otherReviewId}`)).status).toBe(404);
      expect((await c.get(`/api/reviews/${otherReviewId}/tree`)).status).toBe(404);
      expect((await c.get(`/api/reviews/${otherReviewId}/search?q=Secret`)).status).toBe(404);
      expect((await c.get(`/api/reviews/${otherReviewId}/report-preview?mode=working`)).status).toBe(404);
      expect((await c.get(`/api/reviews/${otherReviewId}/reports`)).status).toBe(404);
      expect((await c.get(`/api/tasks/${otherTask}`)).status).toBe(404);
      expect((await c.get(`/api/tasks/${otherTask}/revisions`)).status).toBe(404);
      expect((await c.get(`/api/reports/${snapshotId}`)).status).toBe(404);
      expect((await c.get(`/api/reports/${snapshotId}/download?format=pdf`)).status).toBe(404);
      expect((await c.get(`/api/reports/${snapshotId}/download?format=docx`)).status).toBe(404);
      expect((await save(c, otherTask, '<p>x</p>', 1)).status).toBe(404);
    }
    // Outsider sees nothing of the shared review either.
    expect((await outsider.get(`/api/reviews/${reviewId}/tree`)).status).toBe(404);
    expect((await outsider.get('/api/catalog')).body.reviews).toEqual([]);
    // Invalid identifiers are handled.
    expect((await profA.get('/api/tasks/abc')).status).toBe(404);
    expect((await profA.get('/api/tasks/-1')).status).toBe(404);
    // Admin can read everything.
    expect((await admin.get(`/api/reports/${snapshotId}`)).status).toBe(200);
  });

  it('coordinator access is per-review; faculty cannot list the roster or users', async () => {
    expect((await coord2.post(`/api/reviews/${reviewId}/tasks`, { section: 'past', title: 'x' })).status).toBe(404);
    expect((await profA.get('/api/faculty')).status).toBe(403);
    expect((await profA.get('/api/users')).status).toBe(403);
    expect((await coord.get('/api/users')).status).toBe(403);
    // Only admins grant coordinator access.
    expect((await coord.put(`/api/reviews/${reviewId}/access/${ids.coord2}`, { access: 'coordinator' })).status).toBe(403);
    expect((await admin.put(`/api/reviews/${reviewId}/access/${ids.coord2}`, { access: 'coordinator' })).status).toBe(200);
    expect((await coord2.post(`/api/reviews/${reviewId}/tasks`, { section: 'past', title: 'Now allowed' })).status).toBe(201);
    expect((await admin.put(`/api/reviews/${reviewId}/access/${ids.profA}`, { access: 'coordinator' })).status).toBe(409);
  });

  it('unauthenticated requests are rejected', async () => {
    const anon = request(app());
    expect((await anon.get('/api/catalog')).status).toBe(401);
    expect((await anon.get(`/api/tasks/${taskA}`)).status).toBe(401);
    expect((await anon.get(`/api/reports/${snapshotId}/download?format=pdf`)).status).toBe(401);
  });

  it('CSRF: state changes without the session token or from a foreign origin are rejected', async () => {
    const noToken = await profA.agent.put(`/api/tasks/${taskA}/response`).set('X-Requested-With', 'ProgramAudit').send({ html: '<p>x</p>', baseRevisionNo: 0 });
    expect(noToken.status).toBe(403);
    const noHeader = await profA.agent.put(`/api/tasks/${taskA}/response`).send({ html: '<p>x</p>', baseRevisionNo: 0 });
    expect(noHeader.status).toBe(403);
    const foreign = await profA.put(`/api/tasks/${taskA}/response`, { html: '<p>x</p>', baseRevisionNo: 0 }).set('Origin', 'https://evil.example');
    expect(foreign.status).toBe(403);
  });

  it('stores sanitized narrative HTML only (XSS)', async () => {
    const t = (await profA.get(`/api/tasks/${taskA}`)).body.task;
    await save(profA, taskA, '<p>ok<script>alert(1)</script><img src=x onerror=alert(1)></p><p onmouseover="x">y</p>', t.currentRevisionNo);
    expect((await profA.get(`/api/tasks/${taskA}`)).body.response.html).toBe('<p>ok</p><p>y</p>');
  });

  it('inactive accounts are signed out and cannot sign in', async () => {
    const temp = await createUser('professor', 'Temp Prof');
    const c = await login(temp.email);
    expect((await admin.patch(`/api/users/${temp.id}`, { active: false })).status).toBe(200);
    expect((await c.get('/api/catalog')).status).toBe(401);
    await expect(login(temp.email)).rejects.toThrow(/401/);
  });

  it('the last active administrator cannot be removed', async () => {
    expect((await admin.patch(`/api/users/${ids.admin}`, { role: 'professor' })).status).toBe(409);
    expect((await admin.patch(`/api/users/${ids.admin}`, { active: false })).status).toBe(409);
    const second = await createUser('admin', 'Second Admin');
    expect((await admin.patch(`/api/users/${second.id}`, { active: false })).status).toBe(200);
    expect((await admin.patch(`/api/users/${ids.admin}`, { active: false })).status).toBe(409);
  });

  it('health endpoint reveals no secrets', async () => {
    const res = await request(app()).get('/api/health');
    expect(res.body).toEqual({ status: 'ok', database: 'ok' });
  });
});
