import type { Knex } from 'knex';
import { db } from '../db.js';
import { type Block, hasSubstantiveText, parseNarrative } from '../lib/narrative.js';
import { SECTIONS, type Section, type TaskRow } from '../services/tasks.js';

export type ReportMode = 'working' | 'completed';
export interface ReportOptions {
  attribution: boolean;
}

export type NodeKind = 'narrative' | 'draft' | 'missing' | 'context';

export interface ReportNode {
  taskId: number;
  depth: number;
  outline: string;
  title: string;
  status: TaskRow['status'];
  assignee: string | null;
  kind: NodeKind;
  revisionNo: number | null;
  blocks: Block[];
}

export interface ReportContent {
  schemaVersion: 1;
  reviewId: number;
  title: string;
  curriculum: string;
  major: string;
  period: string;
  description: string;
  generatedAt: string;
  generatedAtLabel: string;
  generatedBy: string;
  mode: ReportMode;
  options: ReportOptions;
  progress: { completed: number; total: number };
  counts: {
    unassigned: number;
    notStarted: number;
    inProgress: number;
    complete: number;
    includedNarratives: number;
    excludedTasks: number;
    unfinishedTasks: number;
  };
  allComplete: boolean;
  unresolved: { taskId: number; section: Section; path: string[]; status: TaskRow['status']; assignee: string | null }[];
  sections: { key: Section; label: string; nodes: ReportNode[] }[];
}

export const SECTION_LABELS: Record<Section, string> = { past: 'Past', present: 'Present', future: 'Future' };

/**
 * Compiles saved content into a report model. Reads happen inside one
 * REPEATABLE READ transaction so every narrative comes from a single,
 * consistent point in time. Faculty text is reproduced verbatim.
 */
export async function buildReport(
  reviewId: number,
  mode: ReportMode,
  options: ReportOptions,
  generatedBy: string,
  timezone: string,
  existingTrx?: Knex.Transaction,
): Promise<{ content: ReportContent; sourceRevisions: { taskId: number; revisionNo: number }[] }> {
  const run = async (trx: Knex.Transaction) => {
    const ctx = await trx('reviews as r')
      .join('majors as m', 'm.id', 'r.major_id')
      .join('curricula as c', 'c.id', 'm.curriculum_id')
      .where('r.id', reviewId)
      .select('r.*', 'm.name as major_name', 'c.name as curriculum_name')
      .first();
    const tasks = (await trx('tasks')
      .where({ review_id: reviewId })
      .whereNull('archived_at')
      .orderBy([{ column: 'sort_order' }, { column: 'id' }])) as TaskRow[];
    const revs = tasks.length
      ? await trx('response_revisions as rr')
          .join('tasks as t', function () {
            this.on('t.id', 'rr.task_id').andOn('t.current_revision_no', 'rr.revision_no');
          })
          .where('t.review_id', reviewId)
          .whereNull('t.archived_at')
          .select('rr.task_id', 'rr.revision_no', 'rr.content_html')
      : [];
    const users = await trx('users').select('id', 'display_name');
    const now = await trx.raw('select now() as now');
    return { ctx, tasks, revs, users, now: now.rows[0].now as Date };
  };

  const data = existingTrx
    ? await run(existingTrx)
    : await db().transaction(run, { isolationLevel: 'repeatable read', readOnly: true } as Knex.TransactionConfig);

  const { ctx, tasks, revs } = data;
  const userName = new Map<number, string>(data.users.map((u: { id: number; display_name: string }) => [u.id, u.display_name]));
  const revByTask = new Map<number, { revision_no: number; content_html: string }>(revs.map((r: any) => [r.task_id, r]));
  const children = new Map<number | null, TaskRow[]>();
  for (const t of tasks) {
    const key = t.parent_id;
    if (!children.has(key)) children.set(key, []);
    children.get(key)!.push(t);
  }
  const kidsOf = (id: number | null, section: Section) => (children.get(id) ?? []).filter((t) => t.section === section);

  // Which nodes have a completed node somewhere in their subtree (including themselves)?
  const hasCompleteBelow = new Map<number, boolean>();
  const markComplete = (t: TaskRow): boolean => {
    let any = t.status === 'complete';
    for (const k of children.get(t.id) ?? []) any = markComplete(k) || any;
    hasCompleteBelow.set(t.id, any);
    return any;
  };
  for (const s of SECTIONS) for (const t of kidsOf(null, s)) markComplete(t);

  const assigneeName = (t: TaskRow) => (t.assignee_id ? userName.get(t.assignee_id) ?? null : null);
  const sourceRevisions: { taskId: number; revisionNo: number }[] = [];
  const unresolved: ReportContent['unresolved'] = [];
  let includedNarratives = 0;

  const sections = SECTIONS.map((key) => {
    const nodes: ReportNode[] = [];
    const walk = (list: TaskRow[], depth: number, prefix: string, path: string[]) => {
      list.forEach((t, i) => {
        const outline = prefix ? `${prefix}.${i + 1}` : `${i + 1}`;
        const rev = revByTask.get(t.id);
        const html = rev?.content_html ?? '';
        const hasText = hasSubstantiveText(html);
        if (t.status !== 'complete') {
          unresolved.push({ taskId: t.id, section: key, path: [...path, t.title], status: t.status, assignee: assigneeName(t) });
        }
        let kind: NodeKind | null;
        if (mode === 'working') kind = t.status === 'complete' ? 'narrative' : hasText ? 'draft' : 'missing';
        else kind = t.status === 'complete' ? 'narrative' : hasCompleteBelow.get(t.id) ? 'context' : null;
        if (kind) {
          const withText = kind === 'narrative' || kind === 'draft';
          if (withText && rev) sourceRevisions.push({ taskId: t.id, revisionNo: rev.revision_no });
          if (kind === 'narrative') includedNarratives++;
          nodes.push({
            taskId: t.id,
            depth,
            outline,
            title: t.title,
            status: t.status,
            assignee: assigneeName(t),
            kind,
            revisionNo: withText && rev ? rev.revision_no : null,
            blocks: withText ? parseNarrative(html) : [],
          });
          walk(kidsOf(t.id, key), depth + 1, outline, [...path, t.title]);
        }
      });
    };
    walk(kidsOf(null, key), 1, '', []);
    return { key, label: SECTION_LABELS[key], nodes };
  });

  const complete = tasks.filter((t) => t.status === 'complete').length;
  const content: ReportContent = {
    schemaVersion: 1,
    reviewId,
    title: ctx.title,
    curriculum: ctx.curriculum_name,
    major: ctx.major_name,
    period: ctx.period,
    description: ctx.description,
    generatedAt: new Date(data.now).toISOString(),
    generatedAtLabel: formatTimestamp(new Date(data.now), timezone),
    generatedBy,
    mode,
    options,
    progress: { completed: complete, total: tasks.length },
    counts: {
      unassigned: tasks.filter((t) => !t.assignee_id).length,
      notStarted: tasks.filter((t) => t.status === 'not_started').length,
      inProgress: tasks.filter((t) => t.status === 'in_progress').length,
      complete,
      includedNarratives,
      excludedTasks: mode === 'completed' ? tasks.length - complete : 0,
      unfinishedTasks: tasks.length - complete,
    },
    allComplete: tasks.length > 0 && complete === tasks.length,
    unresolved,
    sections,
  };
  return { content, sourceRevisions };
}

export function modeLabel(mode: ReportMode) {
  return mode === 'working' ? 'Working report (includes drafts and missing responses)' : 'Completed-response report';
}

/** Plain-language completeness statement. Never claims "final" for unfinished work. */
export function completenessStatement(c: ReportContent): string {
  const { completed, total } = c.progress;
  if (total === 0) return 'No tasks have been defined for this review.';
  if (c.allComplete) return `All ${total} active tasks are marked complete.`;
  const base = `Incomplete: ${completed} of ${total} active tasks are complete; ${total - completed} unfinished.`;
  return c.mode === 'completed' ? `${base} Unfinished tasks are excluded from this report.` : base;
}

export function safeFilename(c: ReportContent, snapshotId: number, ext: 'docx' | 'pdf') {
  const slug = (s: string) =>
    s
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 60) || 'untitled';
  const stamp = c.generatedAt.slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  return `${slug(c.major)}_${slug(c.title)}_${c.mode}_${stamp}Z_snapshot-${snapshotId}.${ext}`;
}

export function nodeStatusLabel(n: ReportNode): string {
  return n.status === 'complete' ? 'Complete' : n.status === 'in_progress' ? 'In progress' : 'Not started';
}

export function formatTimestamp(d: Date, timezone: string) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(d);
}
