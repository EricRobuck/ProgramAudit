import type { Knex } from 'knex';

export type ActivityAction =
  | 'login'
  | 'user.create'
  | 'user.update'
  | 'curriculum.create'
  | 'curriculum.update'
  | 'major.create'
  | 'major.update'
  | 'review.create'
  | 'review.update'
  | 'review.archive'
  | 'review.reopen'
  | 'review.access.grant'
  | 'review.access.revoke'
  | 'task.create'
  | 'task.update'
  | 'task.assign'
  | 'task.move'
  | 'task.archive'
  | 'task.restore'
  | 'response.save'
  | 'response.restore'
  | 'task.complete'
  | 'task.reopen'
  | 'report.generate';

/** Records an audit entry. Never include passwords, tokens or narrative text in details. */
export async function logActivity(
  q: Knex | Knex.Transaction,
  entry: {
    actorId: number | null;
    action: ActivityAction;
    reviewId?: number | null;
    taskId?: number | null;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await q('activity_log').insert({
    actor_id: entry.actorId,
    action: entry.action,
    review_id: entry.reviewId ?? null,
    task_id: entry.taskId ?? null,
    details: JSON.stringify(entry.details ?? {}),
  });
}
