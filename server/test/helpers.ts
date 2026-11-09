import bcrypt from 'bcryptjs';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { db } from '../src/db.js';
import { getConfig } from '../src/config.js';

export const PASSWORD = 'Test-Password-123';
let hash: string | undefined;
let appInstance: Express | undefined;

export function app(): Express {
  if (!appInstance) appInstance = createApp();
  return appInstance;
}
export function resetAppInstance() {
  appInstance = undefined;
}

export async function resetDb() {
  const name = new URL(getConfig().DATABASE_URL).pathname.slice(1);
  if (!name.endsWith('_test')) throw new Error(`Refusing to reset non-test database ${name}`);
  const k = db();
  await k.migrate.latest();
  await k.raw('alter table response_revisions disable trigger response_revisions_immutable');
  await k.raw('alter table report_snapshots disable trigger report_snapshots_immutable');
  await k.raw(
    'truncate activity_log, report_snapshots, response_revisions, tasks, review_access, reviews, majors, curricula, session, users restart identity cascade',
  );
  await k.raw('alter table response_revisions enable trigger response_revisions_immutable');
  await k.raw('alter table report_snapshots enable trigger report_snapshots_immutable');
}

export async function createUser(
  role: 'admin' | 'coordinator' | 'professor',
  name: string,
  opts: { active?: boolean; isFaculty?: boolean } = {},
) {
  hash ??= await bcrypt.hash(PASSWORD, 4);
  const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}@example.test`;
  const [row] = await db()('users')
    .insert({ email, display_name: name, role, password_hash: hash, active: opts.active ?? true, is_faculty: opts.isFaculty ?? role !== 'admin' })
    .returning('*');
  return { id: row.id as number, email, name };
}

export type Client = Awaited<ReturnType<typeof login>>;

/** Signs in and returns helpers that send the session cookie plus CSRF headers. */
export async function login(email: string, password = PASSWORD) {
  const agent = request.agent(app());
  const res = await agent.post('/api/auth/login').set('X-Requested-With', 'ProgramAudit').send({ email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  const csrf = res.body.csrfToken as string;
  const h = (r: request.Test) => r.set('X-Requested-With', 'ProgramAudit').set('X-CSRF-Token', csrf);
  return {
    agent,
    userId: res.body.user.id as number,
    get: (url: string) => agent.get(url),
    post: (url: string, body: unknown = {}) => h(agent.post(url)).send(body as object),
    put: (url: string, body: unknown = {}) => h(agent.put(url)).send(body as object),
    patch: (url: string, body: unknown = {}) => h(agent.patch(url)).send(body as object),
    del: (url: string) => h(agent.delete(url)),
  };
}

/** Builds a curriculum + major + review owned by the given coordinator. */
export async function scaffoldReview(admin: Client, coordinator: Client, names = { curriculum: 'Computing', major: 'Cybersecurity', review: '2026 Program Review' }) {
  let cur = (await admin.get('/api/catalog?includeArchived=1')).body.curricula.find((c: any) => c.name === names.curriculum);
  if (!cur) cur = (await admin.post('/api/curricula', { name: names.curriculum })).body.curriculum;
  let major = (await admin.get('/api/catalog?includeArchived=1')).body.majors.find((m: any) => m.name === names.major && m.curriculumId === cur.id);
  if (!major) major = (await admin.post('/api/majors', { curriculumId: cur.id, name: names.major })).body.major;
  const review = (await coordinator.post('/api/reviews', { majorId: major.id, title: names.review })).body.review;
  return { curriculum: cur, major, review };
}

export async function addTask(c: Client, reviewId: number, section: string, title: string, parentId: number | null = null) {
  const res = await c.post(`/api/reviews/${reviewId}/tasks`, { section, title, parentId });
  if (res.status !== 201) throw new Error(`addTask failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.task as { id: number; section: string; parentId: number | null; status: string; currentRevisionNo: number };
}

export async function save(c: Client, taskId: number, html: string, baseRevisionNo?: number) {
  const base = baseRevisionNo ?? (await c.get(`/api/tasks/${taskId}`)).body.task.currentRevisionNo;
  return c.put(`/api/tasks/${taskId}/response`, { html, baseRevisionNo: base });
}

export async function complete(c: Client, taskId: number) {
  const rev = (await c.get(`/api/tasks/${taskId}`)).body.task.currentRevisionNo;
  return c.post(`/api/tasks/${taskId}/complete`, { revisionNo: rev });
}
