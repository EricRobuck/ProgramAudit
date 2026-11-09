import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { canManage, parseId, requireManage, requireUser, reviewAccess } from '../lib/auth.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { parse, trimmed } from '../lib/validate.js';
import { logActivity } from '../lib/activity.js';
import { reviewOut } from './catalog.js';
import { taskOut, TASK_SELECT } from '../services/tasks.js';

export const reviewsRouter = Router();

reviewsRouter.post('/reviews', async (req, res) => {
  const user = requireUser(req);
  if (user.role === 'professor') throw forbidden('Only coordinators and administrators can create reviews');
  const body = parse(
    z.object({
      majorId: z.number().int().positive(),
      title: trimmed(1, 200),
      period: z.string().trim().max(100).default(''),
      description: z.string().trim().max(5000).default(''),
    }),
    req.body,
  );
  const review = await db().transaction(async (trx) => {
    const major = await trx('majors').where({ id: body.majorId }).first();
    if (!major) throw notFound('Major not found');
    if (major.archived_at) throw conflict('archived', 'Cannot create a review for an archived major');
    const dup = await trx('reviews').where({ major_id: body.majorId }).whereRaw('lower(title) = lower(?)', [body.title]).first();
    if (dup) throw conflict('duplicate', 'This major already has a review with that title');
    const [row] = await trx('reviews')
      .insert({ major_id: body.majorId, title: body.title, period: body.period, description: body.description, created_by: user.id })
      .returning('*');
    await trx('review_access').insert({ review_id: row.id, user_id: user.id, access: 'coordinator', granted_by: user.id });
    await logActivity(trx, { actorId: user.id, action: 'review.create', reviewId: row.id });
    return row;
  });
  res.status(201).json({ review: reviewOut({ ...review, my_access: user.role === 'admin' ? 'admin' : 'coordinator' }) });
});

reviewsRouter.get('/reviews/:id', async (req, res) => {
  const user = requireUser(req);
  const { review, level } = await reviewAccess(user, parseId(req.params.id));
  const ctx = await db()('majors as m')
    .join('curricula as c', 'c.id', 'm.curriculum_id')
    .where('m.id', review.major_id)
    .select('m.id as major_id', 'm.name as major_name', 'c.id as curriculum_id', 'c.name as curriculum_name')
    .first();
  res.json({
    review: reviewOut({ ...review, my_access: level }),
    major: { id: ctx.major_id, name: ctx.major_name },
    curriculum: { id: ctx.curriculum_id, name: ctx.curriculum_name },
  });
});

reviewsRouter.patch('/reviews/:id', async (req, res) => {
  const user = requireUser(req);
  const id = parseId(req.params.id);
  const body = parse(
    z.object({
      title: trimmed(1, 200).optional(),
      period: z.string().trim().max(100).optional(),
      description: z.string().trim().max(5000).optional(),
      archived: z.boolean().optional(),
    }),
    req.body,
  );
  const row = await db().transaction(async (trx) => {
    const { review, level } = await requireManage(user, id, trx, { forUpdate: true, allowArchived: true });
    const editing = body.title !== undefined || body.period !== undefined || body.description !== undefined;
    if (review.archived_at && editing && body.archived !== false) {
      throw conflict('review_archived', 'This review is archived and read-only. Reopen it first.');
    }
    if (body.title) {
      const dup = await trx('reviews').where({ major_id: review.major_id }).whereRaw('lower(title) = lower(?)', [body.title]).whereNot({ id }).first();
      if (dup) throw conflict('duplicate', 'This major already has a review with that title');
    }
    const patch: Record<string, unknown> = { updated_at: trx.fn.now() };
    if (body.title !== undefined) patch.title = body.title;
    if (body.period !== undefined) patch.period = body.period;
    if (body.description !== undefined) patch.description = body.description;
    if (body.archived === true && !review.archived_at) {
      patch.archived_at = trx.fn.now();
      patch.archived_by = user.id;
      await logActivity(trx, { actorId: user.id, action: 'review.archive', reviewId: id });
    } else if (body.archived === false && review.archived_at) {
      patch.archived_at = null;
      patch.archived_by = null;
      await logActivity(trx, { actorId: user.id, action: 'review.reopen', reviewId: id });
    }
    if (editing) await logActivity(trx, { actorId: user.id, action: 'review.update', reviewId: id });
    const [updated] = await trx('reviews').where({ id }).update(patch).returning('*');
    return { ...updated, my_access: level };
  });
  res.json({ review: reviewOut(row) });
});

// ----- Participants -----

reviewsRouter.get('/reviews/:id/access', async (req, res) => {
  const user = requireUser(req);
  const id = parseId(req.params.id);
  await requireManage(user, id, db(), { allowArchived: true });
  const rows = await db()('review_access as a')
    .join('users as u', 'u.id', 'a.user_id')
    .where('a.review_id', id)
    .select('u.id', 'u.display_name', 'u.role', 'u.active', 'a.access')
    .orderBy('u.display_name');
  res.json({
    access: rows.map((r) => ({ userId: r.id, displayName: r.display_name, role: r.role, active: r.active, access: r.access })),
  });
});

reviewsRouter.put('/reviews/:id/access/:userId', async (req, res) => {
  const user = requireUser(req);
  const id = parseId(req.params.id);
  const userId = parseId(req.params.userId);
  const body = parse(z.object({ access: z.enum(['coordinator', 'faculty']) }), req.body);
  await db().transaction(async (trx) => {
    await requireManage(user, id, trx, { forUpdate: true });
    const target = await trx('users').where({ id: userId }).first();
    if (!target) throw notFound('User not found');
    const existing = await trx('review_access').where({ review_id: id, user_id: userId }).first();
    if (body.access === 'coordinator' || existing?.access === 'coordinator') {
      if (user.role !== 'admin') throw forbidden('Only administrators manage coordinator access');
    }
    if (body.access === 'coordinator' && target.role !== 'coordinator') {
      throw conflict('invalid_role', 'Only accounts with the coordinator role can coordinate a review');
    }
    if (!target.active && !existing) throw conflict('inactive_user', 'Inactive accounts cannot be added to a review');
    await trx('review_access')
      .insert({ review_id: id, user_id: userId, access: body.access, granted_by: user.id })
      .onConflict(['review_id', 'user_id'])
      .merge({ access: body.access, granted_by: user.id });
    await logActivity(trx, { actorId: user.id, action: 'review.access.grant', reviewId: id, details: { userId, access: body.access } });
  });
  res.json({ ok: true });
});

reviewsRouter.delete('/reviews/:id/access/:userId', async (req, res) => {
  const user = requireUser(req);
  const id = parseId(req.params.id);
  const userId = parseId(req.params.userId);
  await db().transaction(async (trx) => {
    await requireManage(user, id, trx, { forUpdate: true });
    const existing = await trx('review_access').where({ review_id: id, user_id: userId }).first();
    if (!existing) throw notFound('That user does not have access to this review');
    if (existing.access === 'coordinator' && user.role !== 'admin') throw forbidden('Only administrators manage coordinator access');
    const assigned = await trx('tasks').where({ review_id: id, assignee_id: userId }).whereNull('archived_at').first();
    if (assigned) throw conflict('has_assignments', 'Reassign this person’s tasks before removing their access');
    await trx('review_access').where({ review_id: id, user_id: userId }).del();
    await logActivity(trx, { actorId: user.id, action: 'review.access.revoke', reviewId: id, details: { userId } });
  });
  res.json({ ok: true });
});

// ----- Task tree -----

reviewsRouter.get('/reviews/:id/tree', async (req, res) => {
  const user = requireUser(req);
  const id = parseId(req.params.id);
  const { level } = await reviewAccess(user, id);
  const includeArchived = req.query.includeArchived === '1' && canManage(level);
  const q = db()('tasks as t')
    .leftJoin('response_revisions as r', function () {
      this.on('r.task_id', 't.id').andOn('r.revision_no', 't.current_revision_no');
    })
    .where('t.review_id', id)
    .select(TASK_SELECT)
    .select('r.word_count')
    .orderBy(['t.section', 't.sort_order', 't.id']);
  if (!includeArchived) q.whereNull('t.archived_at');
  const rows = await q;
  const userIds = new Set<number>();
  for (const r of rows) for (const k of ['assignee_id', 'updated_by', 'completed_by'] as const) if (r[k]) userIds.add(r[k]);
  const users = userIds.size
    ? await db()('users').whereIn('id', [...userIds]).select('id', 'display_name', 'active')
    : [];
  res.json({
    tasks: rows.map(taskOut),
    users: Object.fromEntries(users.map((u) => [u.id, { displayName: u.display_name, active: u.active }])),
  });
});

reviewsRouter.get('/reviews/:id/search', async (req, res) => {
  const user = requireUser(req);
  const id = parseId(req.params.id);
  await reviewAccess(user, id);
  const q = parse(z.object({ q: z.string().trim().min(1).max(200) }), req.query).q;
  const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await db()('tasks as t')
    .leftJoin('response_revisions as r', function () {
      this.on('r.task_id', 't.id').andOn('r.revision_no', 't.current_revision_no');
    })
    .where('t.review_id', id)
    .whereNull('t.archived_at')
    .andWhere((w) => w.whereILike('t.title', pattern).orWhereILike('r.plain_text', pattern))
    .select('t.id');
  res.json({ taskIds: rows.map((r) => r.id) });
});

reviewsRouter.get('/reviews/:id/activity', async (req, res) => {
  const user = requireUser(req);
  const id = parseId(req.params.id);
  await requireManage(user, id, db(), { allowArchived: true });
  const rows = await db()('activity_log as a')
    .leftJoin('users as u', 'u.id', 'a.actor_id')
    .leftJoin('tasks as t', 't.id', 'a.task_id')
    .where('a.review_id', id)
    .select('a.id', 'a.action', 'a.details', 'a.created_at', 'a.task_id', 't.title as task_title', 'u.display_name as actor')
    .orderBy('a.id', 'desc')
    .limit(200);
  res.json({
    activity: rows.map((r) => ({
      id: r.id,
      action: r.action,
      details: r.details,
      createdAt: r.created_at,
      taskId: r.task_id,
      taskTitle: r.task_title,
      actor: r.actor,
    })),
  });
});
