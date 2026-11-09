import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { canManage, parseId, requireUser } from '../lib/auth.js';
import { forbidden } from '../lib/errors.js';
import { dateOnly, parse, trimmed } from '../lib/validate.js';
import { reviewOut } from './catalog.js';
import {
  archivePreview,
  archiveTask,
  canEditNarrative,
  completeTask,
  createTask,
  currentResponse,
  getRevision,
  loadTask,
  moveTask,
  reopenTask,
  restoreRevision,
  restoreTask,
  saveResponse,
  SECTIONS,
  setAssignee,
  taskOut,
  taskPath,
  updateTask,
} from '../services/tasks.js';

export const tasksRouter = Router();

const sectionSchema = z.enum(SECTIONS);

tasksRouter.post('/reviews/:id/tasks', async (req, res) => {
  const user = requireUser(req);
  const reviewId = parseId(req.params.id);
  const body = parse(
    z.object({
      section: sectionSchema,
      parentId: z.number().int().positive().nullable().optional(),
      title: trimmed(1, 300),
      instructions: z.string().trim().max(10000).optional(),
      dueDate: dateOnly.nullable().optional(),
    }),
    req.body,
  );
  const task = await createTask(user, reviewId, body);
  res.status(201).json({ task: taskOut(task) });
});

tasksRouter.get('/tasks/:id', async (req, res) => {
  const user = requireUser(req);
  const { task, review, level } = await loadTask(user, parseId(req.params.id));
  const [path, response, ctx] = await Promise.all([
    taskPath(db(), task.id),
    currentResponse(db(), task),
    db()('majors as m')
      .join('curricula as c', 'c.id', 'm.curriculum_id')
      .where('m.id', review.major_id)
      .select('m.id as major_id', 'm.name as major_name', 'c.id as curriculum_id', 'c.name as curriculum_name')
      .first(),
  ]);
  const names = await db()('users')
    .whereIn('id', [task.assignee_id, task.completed_by, task.reopened_by, task.updated_by].filter((x): x is number => !!x))
    .select('id', 'display_name', 'active');
  const writable = !review.archived_at && !task.archived_at;
  const mayEdit = canEditNarrative(user, level, task);
  res.json({
    task: taskOut(task),
    path,
    response,
    review: reviewOut({ ...review, my_access: level }),
    major: { id: ctx.major_id, name: ctx.major_name },
    curriculum: { id: ctx.curriculum_id, name: ctx.curriculum_name },
    users: Object.fromEntries(names.map((u) => [u.id, { displayName: u.display_name, active: u.active }])),
    permissions: {
      canManage: canManage(level),
      canEdit: writable && mayEdit && task.status !== 'complete',
      canComplete: writable && mayEdit && task.status !== 'complete',
      canReopen: writable && canManage(level) && task.status === 'complete',
      canViewHistory: canManage(level) || task.assignee_id === user.id,
    },
  });
});

tasksRouter.patch('/tasks/:id', async (req, res) => {
  const user = requireUser(req);
  const body = parse(
    z.object({
      title: trimmed(1, 300).optional(),
      instructions: z.string().trim().max(10000).optional(),
      dueDate: dateOnly.nullable().optional(),
    }),
    req.body,
  );
  res.json({ task: taskOut(await updateTask(user, parseId(req.params.id), body)) });
});

tasksRouter.put('/tasks/:id/assignee', async (req, res) => {
  const user = requireUser(req);
  const body = parse(z.object({ assigneeId: z.number().int().positive().nullable() }), req.body);
  res.json({ task: taskOut(await setAssignee(user, parseId(req.params.id), body.assigneeId)) });
});

tasksRouter.post('/tasks/:id/move', async (req, res) => {
  const user = requireUser(req);
  const body = parse(
    z.object({
      section: sectionSchema.optional(),
      parentId: z.number().int().positive().nullable(),
      position: z.number().int().min(0).optional(),
    }),
    req.body,
  );
  res.json({ task: taskOut(await moveTask(user, parseId(req.params.id), body)) });
});

tasksRouter.get('/tasks/:id/archive-preview', async (req, res) => {
  res.json(await archivePreview(requireUser(req), parseId(req.params.id)));
});

tasksRouter.post('/tasks/:id/archive', async (req, res) => {
  res.json(await archiveTask(requireUser(req), parseId(req.params.id)));
});

tasksRouter.post('/tasks/:id/restore', async (req, res) => {
  res.json(await restoreTask(requireUser(req), parseId(req.params.id)));
});

tasksRouter.put('/tasks/:id/response', async (req, res) => {
  const user = requireUser(req);
  const body = parse(z.object({ html: z.string(), baseRevisionNo: z.number().int().min(0) }), req.body);
  const result = await saveResponse(user, parseId(req.params.id), body.html, body.baseRevisionNo);
  res.json({ task: taskOut(result.task), response: result.response, unchanged: result.unchanged });
});

tasksRouter.post('/tasks/:id/complete', async (req, res) => {
  const user = requireUser(req);
  const body = parse(z.object({ revisionNo: z.number().int().min(0) }), req.body);
  res.json({ task: taskOut(await completeTask(user, parseId(req.params.id), body.revisionNo)) });
});

tasksRouter.post('/tasks/:id/reopen', async (req, res) => {
  res.json({ task: taskOut(await reopenTask(requireUser(req), parseId(req.params.id))) });
});

tasksRouter.get('/tasks/:id/revisions', async (req, res) => {
  const user = requireUser(req);
  const { task, level } = await loadTask(user, parseId(req.params.id));
  if (!canManage(level) && task.assignee_id !== user.id) throw forbidden();
  const rows = await db()('response_revisions as r')
    .join('users as u', 'u.id', 'r.author_id')
    .where('r.task_id', task.id)
    .select('r.revision_no', 'r.word_count', 'r.created_at', 'r.restored_from_revision_no', 'u.display_name')
    .orderBy('r.revision_no', 'desc');
  res.json({
    revisions: rows.map((r) => ({
      revisionNo: r.revision_no,
      wordCount: r.word_count,
      createdAt: r.created_at,
      authorName: r.display_name,
      restoredFromRevisionNo: r.restored_from_revision_no,
    })),
    completedRevisionNo: task.completed_revision_no,
  });
});

tasksRouter.get('/tasks/:id/revisions/:no', async (req, res) => {
  const user = requireUser(req);
  const { task, level } = await loadTask(user, parseId(req.params.id));
  if (!canManage(level) && task.assignee_id !== user.id) throw forbidden();
  res.json({ revision: await getRevision(db(), task.id, parseId(req.params.no)) });
});

tasksRouter.post('/tasks/:id/revisions/:no/restore', async (req, res) => {
  const user = requireUser(req);
  const body = parse(z.object({ baseRevisionNo: z.number().int().min(0) }), req.body);
  const result = await restoreRevision(user, parseId(req.params.id), parseId(req.params.no), body.baseRevisionNo);
  res.json({ task: taskOut(result.task), response: result.response });
});

/** Tasks assigned to the signed-in user, across their reviews. */
tasksRouter.get('/my-tasks', async (req, res) => {
  const user = requireUser(req);
  const r = await db().raw(
    `with recursive mine as (
       select t.id from tasks t
       join reviews rv on rv.id = t.review_id
       where t.assignee_id = ? and t.archived_at is null
     ),
     anc as (
       select m.id as task_id, t.id, t.parent_id, t.title, 0 as d
       from mine m join tasks t on t.id = m.id
       union all
       select anc.task_id, p.id, p.parent_id, p.title, anc.d + 1
       from anc join tasks p on p.id = anc.parent_id
     )
     select t.id, t.title, t.section, t.status, t.due_date, t.review_id, t.updated_at,
            rv.title as review_title, rv.archived_at as review_archived_at,
            m.name as major_name, c.name as curriculum_name, m.id as major_id, c.id as curriculum_id,
            (select array_agg(a.title order by a.d desc) from anc a where a.task_id = t.id) as path
     from tasks t
     join reviews rv on rv.id = t.review_id
     join majors m on m.id = rv.major_id
     join curricula c on c.id = m.curriculum_id
     where t.id in (select id from mine)
     order by (t.status = 'complete'), t.due_date nulls last, rv.title, t.id`,
    [user.id],
  );
  res.json({
    tasks: r.rows.map((x: any) => ({
      id: x.id,
      title: x.title,
      section: x.section,
      status: x.status,
      dueDate: x.due_date,
      reviewId: x.review_id,
      reviewTitle: x.review_title,
      reviewArchived: !!x.review_archived_at,
      majorId: x.major_id,
      majorName: x.major_name,
      curriculumId: x.curriculum_id,
      curriculumName: x.curriculum_name,
      path: x.path,
      updatedAt: x.updated_at,
    })),
  });
});
