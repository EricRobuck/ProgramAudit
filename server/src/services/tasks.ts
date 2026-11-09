import crypto from 'node:crypto';
import type { Knex } from 'knex';
import { db } from '../db.js';
import { type AuthUser, canManage, requireManage, reviewAccess, type ReviewAccessLevel, type ReviewRow } from '../lib/auth.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../lib/errors.js';
import { logActivity } from '../lib/activity.js';
import {
  hasSubstantiveText,
  MAX_NARRATIVE_LENGTH,
  narrativePlainText,
  sanitizeNarrative,
  wordCount,
} from '../lib/narrative.js';

/** Maximum depth of a task tree. A top-level task is depth 1. */
export const MAX_DEPTH = 10;
export const SECTIONS = ['past', 'present', 'future'] as const;
export type Section = (typeof SECTIONS)[number];

export const TASK_SELECT = [
  't.id', 't.review_id', 't.section', 't.parent_id', 't.title', 't.instructions', 't.assignee_id', 't.due_date',
  't.status', 't.sort_order', 't.current_revision_no', 't.completed_at', 't.completed_by', 't.completed_revision_no',
  't.reopened_at', 't.reopened_by', 't.archived_at', 't.created_by', 't.updated_by', 't.created_at', 't.updated_at',
];

export interface TaskRow {
  id: number;
  review_id: number;
  section: Section;
  parent_id: number | null;
  title: string;
  instructions: string;
  assignee_id: number | null;
  due_date: string | null;
  status: 'not_started' | 'in_progress' | 'complete';
  sort_order: number;
  current_revision_no: number;
  completed_at: Date | null;
  completed_by: number | null;
  completed_revision_no: number | null;
  reopened_at: Date | null;
  reopened_by: number | null;
  archived_at: Date | null;
  archive_batch: string | null;
  created_by: number;
  updated_by: number;
  created_at: Date;
  updated_at: Date;
  word_count?: number | null;
}

export function taskOut(t: TaskRow) {
  return {
    id: t.id,
    reviewId: t.review_id,
    section: t.section,
    parentId: t.parent_id,
    title: t.title,
    instructions: t.instructions,
    assigneeId: t.assignee_id,
    dueDate: t.due_date,
    status: t.status,
    sortOrder: t.sort_order,
    currentRevisionNo: t.current_revision_no,
    wordCount: t.word_count ?? 0,
    completedAt: t.completed_at,
    completedBy: t.completed_by,
    reopenedAt: t.reopened_at,
    reopenedBy: t.reopened_by,
    archived: !!t.archived_at,
    createdBy: t.created_by,
    updatedBy: t.updated_by,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
  };
}

type Q = Knex | Knex.Transaction;

export async function loadTask(
  user: AuthUser,
  taskId: number,
  q: Q = db(),
  opts: { forUpdate?: boolean } = {},
): Promise<{ task: TaskRow; review: ReviewRow; level: ReviewAccessLevel }> {
  if (!Number.isSafeInteger(taskId) || taskId <= 0) throw notFound('Task not found');
  const peek = await q('tasks').where({ id: taskId }).select('review_id').first();
  if (!peek) throw notFound('Task not found');
  // Authorization first, so callers without access learn nothing about the task.
  const { review, level } = await reviewAccess(user, peek.review_id, q, { forUpdate: opts.forUpdate });
  const tq = q('tasks').where({ id: taskId }).first();
  if (opts.forUpdate) tq.forUpdate();
  const task = (await tq) as TaskRow;
  return { task, review, level };
}

function assertWritable(review: ReviewRow, task?: TaskRow) {
  if (review.archived_at) throw conflict('review_archived', 'This review is archived and read-only. Reopen it first.');
  if (task?.archived_at) throw conflict('task_archived', 'This task is archived. Restore it before making changes.');
}

export function canEditNarrative(user: AuthUser, level: ReviewAccessLevel, task: TaskRow) {
  return canManage(level) || task.assignee_id === user.id;
}

async function depthOf(q: Q, taskId: number): Promise<number> {
  const r = await q.raw(
    `with recursive anc as (
       select id, parent_id, 1 as d from tasks where id = ?
       union all
       select t.id, t.parent_id, anc.d + 1 from tasks t join anc on t.id = anc.parent_id
     ) select max(d) as depth from anc`,
    [taskId],
  );
  return Number(r.rows[0].depth);
}

/** Height of the subtree rooted at taskId (1 = leaf), including archived descendants. */
async function subtreeHeight(q: Q, taskId: number): Promise<number> {
  const r = await q.raw(
    `with recursive sub as (
       select id, 1 as h from tasks where id = ?
       union all
       select t.id, sub.h + 1 from tasks t join sub on t.parent_id = sub.id
     ) select max(h) as height from sub`,
    [taskId],
  );
  return Number(r.rows[0].height);
}

export async function descendantIds(q: Q, taskId: number, opts: { activeOnly?: boolean } = {}): Promise<number[]> {
  const r = await q.raw(
    `with recursive sub as (
       select id, archived_at from tasks where parent_id = ?
       union all
       select t.id, t.archived_at from tasks t join sub on t.parent_id = sub.id
     ) select id from sub ${opts.activeOnly ? 'where archived_at is null' : ''}`,
    [taskId],
  );
  return r.rows.map((x: { id: number }) => Number(x.id));
}

function siblingsQuery(q: Q, reviewId: number, section: Section, parentId: number | null) {
  const s = q('tasks').where({ review_id: reviewId, section }).orderBy([{ column: 'sort_order' }, { column: 'id' }]);
  if (parentId === null) s.whereNull('parent_id');
  else s.where({ parent_id: parentId });
  return s.select('id', 'archived_at');
}

/**
 * Re-numbers a sibling list. `insertId` is placed before the `position`-th
 * active sibling (or last). Archived siblings keep their relative position.
 */
async function writeSiblingOrder(
  q: Q,
  siblings: { id: number; archived_at: Date | null }[],
  insertId?: number,
  position?: number,
) {
  const list = siblings.filter((s) => s.id !== insertId);
  if (insertId !== undefined) {
    let idx = list.length;
    if (position !== undefined) {
      let active = 0;
      for (let i = 0; i < list.length; i++) {
        if (!list[i].archived_at) {
          if (active === position) {
            idx = i;
            break;
          }
          active++;
        }
      }
    }
    list.splice(idx, 0, { id: insertId, archived_at: null });
  }
  for (let i = 0; i < list.length; i++) {
    await q('tasks').where({ id: list[i].id }).update({ sort_order: (i + 1) * 10 });
  }
}

async function resolveParent(q: Q, reviewId: number, parentId: number | null | undefined) {
  if (parentId === null || parentId === undefined) return null;
  const parent = (await q('tasks').where({ id: parentId }).first()) as TaskRow | undefined;
  if (!parent || parent.review_id !== reviewId) throw badRequest('Parent task must belong to the same review');
  if (parent.archived_at) throw badRequest('Cannot place a task under an archived parent');
  return parent;
}

export async function createTask(
  user: AuthUser,
  reviewId: number,
  input: { section: Section; parentId?: number | null; title: string; instructions?: string; dueDate?: string | null },
) {
  return db().transaction(async (trx) => {
    await requireManage(user, reviewId, trx, { forUpdate: true });
    const parent = await resolveParent(trx, reviewId, input.parentId);
    const section = parent ? parent.section : input.section;
    if (parent && input.section && parent.section !== input.section) {
      throw badRequest('Parent task is in a different section');
    }
    if (parent && (await depthOf(trx, parent.id)) + 1 > MAX_DEPTH) {
      throw badRequest(`Tasks can be nested at most ${MAX_DEPTH} levels deep`);
    }
    const max = await trx('tasks')
      .where({ review_id: reviewId, section })
      .andWhere((w) => (parent ? w.where('parent_id', parent.id) : w.whereNull('parent_id')))
      .max({ m: 'sort_order' })
      .first();
    const [row] = await trx('tasks')
      .insert({
        review_id: reviewId,
        section,
        parent_id: parent?.id ?? null,
        title: input.title,
        instructions: input.instructions ?? '',
        due_date: input.dueDate ?? null,
        assignee_id: null, // New tasks and subtasks always start unassigned.
        sort_order: Number(max?.m ?? 0) + 10,
        created_by: user.id,
        updated_by: user.id,
      })
      .returning('*');
    await logActivity(trx, { actorId: user.id, action: 'task.create', reviewId, taskId: row.id, details: { section, parentId: row.parent_id } });
    return row as TaskRow;
  });
}

export async function updateTask(
  user: AuthUser,
  taskId: number,
  input: { title?: string; instructions?: string; dueDate?: string | null },
) {
  return db().transaction(async (trx) => {
    const { task, review, level } = await loadTask(user, taskId, trx, { forUpdate: true });
    if (!canManage(level)) throw forbidden('Coordinator access to this review is required');
    assertWritable(review, task);
    const patch: Record<string, unknown> = { updated_at: trx.fn.now(), updated_by: user.id };
    if (input.title !== undefined) patch.title = input.title;
    if (input.instructions !== undefined) patch.instructions = input.instructions;
    if (input.dueDate !== undefined) patch.due_date = input.dueDate;
    const [row] = await trx('tasks').where({ id: taskId }).update(patch).returning('*');
    await logActivity(trx, { actorId: user.id, action: 'task.update', reviewId: task.review_id, taskId, details: { fields: Object.keys(input) } });
    return row as TaskRow;
  });
}

export async function setAssignee(user: AuthUser, taskId: number, assigneeId: number | null) {
  return db().transaction(async (trx) => {
    const { task, review, level } = await loadTask(user, taskId, trx, { forUpdate: true });
    if (!canManage(level)) throw forbidden('Only the review coordinator can change assignments');
    assertWritable(review, task);
    if (assigneeId !== null) {
      const assignee = await trx('users').where({ id: assigneeId }).first();
      if (!assignee) throw badRequest('Selected professor does not exist');
      if (!assignee.active) throw badRequest('Inactive accounts cannot receive new assignments');
      if (!assignee.is_faculty) throw badRequest('Selected account is not a faculty member');
      // Assignment grants read access to the review so the professor can see context.
      await trx('review_access')
        .insert({ review_id: task.review_id, user_id: assigneeId, access: 'faculty', granted_by: user.id })
        .onConflict(['review_id', 'user_id'])
        .ignore();
    }
    // Only this node changes; descendants keep their own owners.
    const [row] = await trx('tasks')
      .where({ id: taskId })
      .update({ assignee_id: assigneeId, updated_by: user.id, updated_at: trx.fn.now() })
      .returning('*');
    await logActivity(trx, {
      actorId: user.id,
      action: 'task.assign',
      reviewId: task.review_id,
      taskId,
      details: { from: task.assignee_id, to: assigneeId },
    });
    return row as TaskRow;
  });
}

export async function moveTask(
  user: AuthUser,
  taskId: number,
  input: { section?: Section; parentId: number | null; position?: number },
) {
  return db().transaction(async (trx) => {
    const { task, review, level } = await loadTask(user, taskId, trx, { forUpdate: true });
    if (!canManage(level)) throw forbidden('Coordinator access to this review is required');
    assertWritable(review, task);
    const parent = await resolveParent(trx, task.review_id, input.parentId);
    if (parent) {
      if (parent.id === task.id) throw badRequest('A task cannot be its own parent');
      const desc = await descendantIds(trx, task.id);
      if (desc.includes(parent.id)) throw badRequest('A task cannot be moved beneath its own subtask');
      if (input.section && input.section !== parent.section) throw badRequest('Parent task is in a different section');
    } else if (!input.section) {
      throw badRequest('Choose a section for a top-level task');
    }
    const section = parent ? parent.section : input.section!;
    const newDepth = parent ? (await depthOf(trx, parent.id)) + 1 : 1;
    const height = await subtreeHeight(trx, task.id);
    if (newDepth + height - 1 > MAX_DEPTH) {
      throw badRequest(`That move would nest tasks more than ${MAX_DEPTH} levels deep`);
    }
    const oldSiblings = await siblingsQuery(trx, task.review_id, task.section, task.parent_id);
    // The section change cascades through the subtree via the composite foreign key.
    await trx('tasks')
      .where({ id: taskId })
      .update({ parent_id: parent?.id ?? null, section, updated_by: user.id, updated_at: trx.fn.now() });
    await writeSiblingOrder(trx, oldSiblings.filter((s) => s.id !== taskId));
    const newSiblings = await siblingsQuery(trx, task.review_id, section, parent?.id ?? null);
    await writeSiblingOrder(trx, newSiblings, taskId, input.position);
    await logActivity(trx, {
      actorId: user.id,
      action: 'task.move',
      reviewId: task.review_id,
      taskId,
      details: {
        from: { section: task.section, parentId: task.parent_id },
        to: { section, parentId: parent?.id ?? null, position: input.position ?? null },
      },
    });
    return (await trx('tasks').where({ id: taskId }).first()) as TaskRow;
  });
}

export async function archivePreview(user: AuthUser, taskId: number) {
  const { task, level } = await loadTask(user, taskId);
  if (!canManage(level)) throw forbidden();
  const desc = await descendantIds(db(), task.id, { activeOnly: true });
  return { descendantCount: desc.length };
}

export async function archiveTask(user: AuthUser, taskId: number) {
  return db().transaction(async (trx) => {
    const { task, review, level } = await loadTask(user, taskId, trx, { forUpdate: true });
    if (!canManage(level)) throw forbidden('Coordinator access to this review is required');
    assertWritable(review, task);
    const ids = [task.id, ...(await descendantIds(trx, task.id, { activeOnly: true }))];
    const batch = crypto.randomUUID();
    await trx('tasks')
      .whereIn('id', ids)
      .update({ archived_at: trx.fn.now(), archived_by: user.id, archive_batch: batch, updated_at: trx.fn.now(), updated_by: user.id });
    await logActivity(trx, {
      actorId: user.id,
      action: 'task.archive',
      reviewId: task.review_id,
      taskId,
      details: { archivedTaskIds: ids, batch },
    });
    return { archivedCount: ids.length };
  });
}

export async function restoreTask(user: AuthUser, taskId: number) {
  return db().transaction(async (trx) => {
    const { task, review, level } = await loadTask(user, taskId, trx, { forUpdate: true });
    if (!canManage(level)) throw forbidden('Coordinator access to this review is required');
    assertWritable(review);
    if (!task.archived_at) throw conflict('not_archived', 'This task is not archived');
    if (task.parent_id) {
      const parent = await trx('tasks').where({ id: task.parent_id }).first();
      if (parent.archived_at) throw conflict('parent_archived', 'Restore the parent task first');
    }
    // Restore the task and the descendants that were archived together with it.
    const desc = await descendantIds(trx, task.id);
    const ids = [task.id, ...(desc.length ? await trx('tasks').whereIn('id', desc).where({ archive_batch: task.archive_batch }).pluck('id') : [])];
    await trx('tasks')
      .whereIn('id', ids)
      .update({ archived_at: null, archived_by: null, archive_batch: null, updated_at: trx.fn.now(), updated_by: user.id });
    await logActivity(trx, { actorId: user.id, action: 'task.restore', reviewId: task.review_id, taskId, details: { restoredTaskIds: ids } });
    return { restoredCount: ids.length };
  });
}

// ----- Narrative responses -----

async function revisionOut(q: Q, taskId: number, revisionNo: number) {
  if (revisionNo === 0) return { revisionNo: 0, html: '', wordCount: 0, authorId: null, authorName: null, createdAt: null };
  const r = await q('response_revisions as r')
    .join('users as u', 'u.id', 'r.author_id')
    .where({ 'r.task_id': taskId, 'r.revision_no': revisionNo })
    .select('r.*', 'u.display_name')
    .first();
  if (!r) throw notFound('Revision not found');
  return {
    revisionNo: r.revision_no,
    html: r.content_html,
    wordCount: r.word_count,
    authorId: r.author_id,
    authorName: r.display_name,
    createdAt: r.created_at,
    restoredFromRevisionNo: r.restored_from_revision_no,
  };
}

export const currentResponse = (q: Q, task: TaskRow) => revisionOut(q, task.id, task.current_revision_no);
export const getRevision = revisionOut;

async function writeRevision(
  trx: Knex.Transaction,
  user: AuthUser,
  task: TaskRow,
  html: string,
  restoredFrom: number | null,
) {
  const no = task.current_revision_no + 1;
  await trx('response_revisions').insert({
    task_id: task.id,
    revision_no: no,
    content_html: html,
    plain_text: narrativePlainText(html),
    word_count: wordCount(html),
    author_id: user.id,
    restored_from_revision_no: restoredFrom,
  });
  const patch: Record<string, unknown> = {
    current_revision_no: no,
    updated_by: user.id,
    updated_at: trx.fn.now(),
  };
  if (task.status === 'not_started' && hasSubstantiveText(html)) patch.status = 'in_progress';
  const [row] = await trx('tasks').where({ id: task.id }).update(patch).returning('*');
  return row as TaskRow;
}

function assertNarrativeEditable(user: AuthUser, level: ReviewAccessLevel, review: ReviewRow, task: TaskRow) {
  if (!canEditNarrative(user, level, task)) throw forbidden('Only the assigned professor or a coordinator can edit this response');
  assertWritable(review, task);
  if (task.status === 'complete') throw conflict('task_complete', 'This response is complete and read-only until a coordinator reopens it');
}

async function staleConflict(q: Q, task: TaskRow): Promise<never> {
  throw new HttpError(409, 'revision_conflict', 'This response was changed by someone else since you opened it.', {
    current: await currentResponse(q, task),
  });
}

export async function saveResponse(user: AuthUser, taskId: number, rawHtml: string, baseRevisionNo: number) {
  if (rawHtml.length > MAX_NARRATIVE_LENGTH) throw badRequest('Response is too long');
  const html = sanitizeNarrative(rawHtml);
  return db().transaction(async (trx) => {
    const { task, review, level } = await loadTask(user, taskId, trx, { forUpdate: true });
    assertNarrativeEditable(user, level, review, task);
    if (baseRevisionNo !== task.current_revision_no) await staleConflict(trx, task);
    const current = await currentResponse(trx, task);
    if (current.html === html) return { task, response: current, unchanged: true };
    const updated = await writeRevision(trx, user, task, html, null);
    await logActivity(trx, {
      actorId: user.id,
      action: 'response.save',
      reviewId: task.review_id,
      taskId,
      details: { revisionNo: updated.current_revision_no },
    });
    return { task: updated, response: await currentResponse(trx, updated), unchanged: false };
  });
}

export async function restoreRevision(user: AuthUser, taskId: number, revisionNo: number, baseRevisionNo: number) {
  return db().transaction(async (trx) => {
    const { task, review, level } = await loadTask(user, taskId, trx, { forUpdate: true });
    if (!canManage(level)) throw forbidden('Only coordinators can restore earlier revisions');
    assertNarrativeEditable(user, level, review, task);
    if (baseRevisionNo !== task.current_revision_no) await staleConflict(trx, task);
    const rev = await trx('response_revisions').where({ task_id: taskId, revision_no: revisionNo }).first();
    if (!rev) throw notFound('Revision not found');
    const updated = await writeRevision(trx, user, task, rev.content_html, revisionNo);
    await logActivity(trx, {
      actorId: user.id,
      action: 'response.restore',
      reviewId: task.review_id,
      taskId,
      details: { restoredFrom: revisionNo, revisionNo: updated.current_revision_no },
    });
    return { task: updated, response: await currentResponse(trx, updated) };
  });
}

export async function completeTask(user: AuthUser, taskId: number, revisionNo: number) {
  return db().transaction(async (trx) => {
    const { task, review, level } = await loadTask(user, taskId, trx, { forUpdate: true });
    assertNarrativeEditable(user, level, review, task);
    if (revisionNo !== task.current_revision_no) await staleConflict(trx, task);
    const current = await currentResponse(trx, task);
    if (!hasSubstantiveText(current.html)) {
      throw new HttpError(422, 'empty_response', 'Write and save a response with visible text before marking it complete');
    }
    // Completion and the exact revision it covers are recorded in one statement.
    const [row] = await trx('tasks')
      .where({ id: taskId })
      .update({
        status: 'complete',
        completed_at: trx.fn.now(),
        completed_by: user.id,
        completed_revision_no: task.current_revision_no,
        updated_by: user.id,
        updated_at: trx.fn.now(),
      })
      .returning('*');
    await logActivity(trx, { actorId: user.id, action: 'task.complete', reviewId: task.review_id, taskId, details: { revisionNo } });
    return row as TaskRow;
  });
}

export async function reopenTask(user: AuthUser, taskId: number) {
  return db().transaction(async (trx) => {
    const { task, review, level } = await loadTask(user, taskId, trx, { forUpdate: true });
    if (!canManage(level)) throw forbidden('Only coordinators can reopen completed work');
    assertWritable(review, task);
    if (task.status !== 'complete') throw conflict('not_complete', 'This task is not complete');
    const [row] = await trx('tasks')
      .where({ id: taskId })
      .update({
        status: 'in_progress',
        completed_at: null,
        completed_by: null,
        completed_revision_no: null,
        reopened_at: trx.fn.now(),
        reopened_by: user.id,
        updated_by: user.id,
        updated_at: trx.fn.now(),
      })
      .returning('*');
    await logActivity(trx, {
      actorId: user.id,
      action: 'task.reopen',
      reviewId: task.review_id,
      taskId,
      details: { previouslyCompletedRevision: task.completed_revision_no, completedBy: task.completed_by },
    });
    return row as TaskRow;
  });
}

export async function taskPath(q: Q, taskId: number): Promise<{ id: number; title: string }[]> {
  const r = await q.raw(
    `with recursive anc as (
       select id, parent_id, title, 0 as d from tasks where id = ?
       union all
       select t.id, t.parent_id, t.title, anc.d + 1 from tasks t join anc on t.id = anc.parent_id
     ) select id, title from anc order by d desc`,
    [taskId],
  );
  return r.rows.map((x: { id: number; title: string }) => ({ id: Number(x.id), title: x.title }));
}
