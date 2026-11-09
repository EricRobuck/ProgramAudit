import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { parseId, requireAdmin, requireUser } from '../lib/auth.js';
import { conflict, notFound } from '../lib/errors.js';
import { parse, trimmed } from '../lib/validate.js';
import { logActivity } from '../lib/activity.js';

export const catalogRouter = Router();

const curriculumOut = (r: any) => ({ id: r.id, name: r.name, archived: !!r.archived_at });
const majorOut = (r: any) => ({ id: r.id, curriculumId: r.curriculum_id, name: r.name, archived: !!r.archived_at });
export const reviewOut = (r: any) => ({
  id: r.id,
  majorId: r.major_id,
  title: r.title,
  period: r.period,
  description: r.description,
  archived: !!r.archived_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  ...(r.my_access !== undefined && { myAccess: r.my_access }),
});

/**
 * Curriculum → major → review data for the selection dropdowns, filtered to
 * what the caller may see. Professors only see catalog entries that contain a
 * review they participate in.
 */
catalogRouter.get('/catalog', async (req, res) => {
  const user = requireUser(req);
  const includeArchived = req.query.includeArchived === '1' && user.role !== 'professor';
  const k = db();

  const reviewsQ = k('reviews as r').select('r.*').orderBy([{ column: 'r.created_at', order: 'desc' }]);
  if (user.role === 'admin') reviewsQ.select(k.raw(`'admin' as my_access`));
  else {
    reviewsQ
      .join('review_access as a', function () {
        this.on('a.review_id', 'r.id').andOn('a.user_id', k.raw('?', [user.id]));
      })
      .select(k.raw(`case when a.access = 'coordinator' and ? = 'coordinator' then 'coordinator' else 'faculty' end as my_access`, [user.role]));
  }
  const reviews = await reviewsQ;

  let curricula = await k('curricula').orderBy('name');
  let majors = await k('majors').orderBy('name');
  if (user.role === 'professor') {
    const majorIds = new Set(reviews.map((r) => r.major_id));
    majors = majors.filter((m) => majorIds.has(m.id));
    const curIds = new Set(majors.map((m) => m.curriculum_id));
    curricula = curricula.filter((c) => curIds.has(c.id));
  } else if (!includeArchived) {
    // Archived catalog entries stay visible when they still hold reviews the user can open.
    const majorIdsWithReviews = new Set(reviews.map((r) => r.major_id));
    const curIdsWithReviews = new Set(majors.filter((m) => majorIdsWithReviews.has(m.id)).map((m) => m.curriculum_id));
    curricula = curricula.filter((c) => !c.archived_at || curIdsWithReviews.has(c.id));
    const visibleCur = new Set(curricula.map((c) => c.id));
    majors = majors.filter(
      (m) => visibleCur.has(m.curriculum_id) && (majorIdsWithReviews.has(m.id) || (!m.archived_at && !curricula.find((c) => c.id === m.curriculum_id)?.archived_at)),
    );
  }
  res.json({
    curricula: curricula.map(curriculumOut),
    majors: majors.map(majorOut),
    reviews: reviews.map(reviewOut),
  });
});

catalogRouter.post('/curricula', async (req, res) => {
  const admin = requireAdmin(req);
  const body = parse(z.object({ name: trimmed(1, 200) }), req.body);
  const dup = await db()('curricula').whereRaw('lower(name) = lower(?)', [body.name]).first();
  if (dup) throw conflict('duplicate', 'A curriculum with that name already exists');
  const [row] = await db()('curricula').insert({ name: body.name }).returning('*');
  await logActivity(db(), { actorId: admin.id, action: 'curriculum.create', details: { curriculumId: row.id } });
  res.status(201).json({ curriculum: curriculumOut(row) });
});

catalogRouter.patch('/curricula/:id', async (req, res) => {
  const admin = requireAdmin(req);
  const id = parseId(req.params.id);
  const body = parse(z.object({ name: trimmed(1, 200).optional(), archived: z.boolean().optional() }), req.body);
  const cur = await db()('curricula').where({ id }).first();
  if (!cur) throw notFound('Curriculum not found');
  if (body.name) {
    const dup = await db()('curricula').whereRaw('lower(name) = lower(?)', [body.name]).whereNot({ id }).first();
    if (dup) throw conflict('duplicate', 'A curriculum with that name already exists');
  }
  const patch: Record<string, unknown> = { updated_at: db().fn.now() };
  if (body.name) patch.name = body.name;
  if (body.archived !== undefined) patch.archived_at = body.archived ? db().fn.now() : null;
  const [row] = await db()('curricula').where({ id }).update(patch).returning('*');
  await logActivity(db(), { actorId: admin.id, action: 'curriculum.update', details: { curriculumId: id, ...body } });
  res.json({ curriculum: curriculumOut(row) });
});

catalogRouter.post('/majors', async (req, res) => {
  const admin = requireAdmin(req);
  const body = parse(z.object({ curriculumId: z.number().int().positive(), name: trimmed(1, 200) }), req.body);
  const cur = await db()('curricula').where({ id: body.curriculumId }).first();
  if (!cur) throw notFound('Curriculum not found');
  if (cur.archived_at) throw conflict('archived', 'Cannot add a major to an archived curriculum');
  const dup = await db()('majors').where({ curriculum_id: body.curriculumId }).whereRaw('lower(name) = lower(?)', [body.name]).first();
  if (dup) throw conflict('duplicate', 'That curriculum already has a major with this name');
  const [row] = await db()('majors').insert({ curriculum_id: body.curriculumId, name: body.name }).returning('*');
  await logActivity(db(), { actorId: admin.id, action: 'major.create', details: { majorId: row.id } });
  res.status(201).json({ major: majorOut(row) });
});

catalogRouter.patch('/majors/:id', async (req, res) => {
  const admin = requireAdmin(req);
  const id = parseId(req.params.id);
  const body = parse(z.object({ name: trimmed(1, 200).optional(), archived: z.boolean().optional() }), req.body);
  const major = await db()('majors').where({ id }).first();
  if (!major) throw notFound('Major not found');
  if (body.name) {
    const dup = await db()('majors')
      .where({ curriculum_id: major.curriculum_id })
      .whereRaw('lower(name) = lower(?)', [body.name])
      .whereNot({ id })
      .first();
    if (dup) throw conflict('duplicate', 'That curriculum already has a major with this name');
  }
  const patch: Record<string, unknown> = { updated_at: db().fn.now() };
  if (body.name) patch.name = body.name;
  if (body.archived !== undefined) patch.archived_at = body.archived ? db().fn.now() : null;
  const [row] = await db()('majors').where({ id }).update(patch).returning('*');
  await logActivity(db(), { actorId: admin.id, action: 'major.update', details: { majorId: id, ...body } });
  res.json({ major: majorOut(row) });
});
