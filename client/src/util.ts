import type { Section, Status, Task } from './types';

export const STATUS_LABEL: Record<Status, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  complete: 'Complete',
};

/** Today's calendar date (YYYY-MM-DD) in the given IANA timezone. */
export function todayIn(timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export function isOverdue(t: Pick<Task, 'dueDate' | 'status'>, today: string): boolean {
  return !!t.dueDate && t.status !== 'complete' && t.dueDate < today;
}

export function formatDateTime(iso: string | null | undefined, timezone: string): string {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
}

/** Formats a calendar date without any timezone conversion. */
export function formatDate(d: string | null | undefined): string {
  if (!d) return '';
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
}

export interface TreeNode {
  task: Task;
  children: TreeNode[];
  depth: number;
  /** Completed active nodes / all active nodes in this subtree, including the node itself. */
  subtree: { completed: number; total: number };
}

export function buildForest(tasks: Task[]): Record<Section, TreeNode[]> {
  const byParent = new Map<number | null, Task[]>();
  for (const t of tasks) {
    const k = t.parentId;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k)!.push(t);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  const build = (t: Task, depth: number): TreeNode => {
    const children = (byParent.get(t.id) ?? []).map((c) => build(c, depth + 1));
    const active = !t.archived;
    const subtree = children.reduce(
      (acc, c) => ({ completed: acc.completed + c.subtree.completed, total: acc.total + c.subtree.total }),
      { completed: active && t.status === 'complete' ? 1 : 0, total: active ? 1 : 0 },
    );
    return { task: t, children, depth, subtree };
  };
  const roots = byParent.get(null) ?? [];
  return {
    past: roots.filter((t) => t.section === 'past').map((t) => build(t, 1)),
    present: roots.filter((t) => t.section === 'present').map((t) => build(t, 1)),
    future: roots.filter((t) => t.section === 'future').map((t) => build(t, 1)),
  };
}

export function progressText(p: { completed: number; total: number }): string {
  if (p.total === 0) return 'No tasks';
  return `${p.completed} of ${p.total} complete (${Math.round((p.completed / p.total) * 100)}%)`;
}

/** Keep nodes that match, plus all their ancestors (for context). Returns visible ids and direct-match ids. */
export function filterTree(forest: TreeNode[], matches: (t: Task) => boolean) {
  const visible = new Set<number>();
  const direct = new Set<number>();
  const walk = (n: TreeNode): boolean => {
    let any = false;
    for (const c of n.children) any = walk(c) || any;
    if (matches(n.task)) {
      direct.add(n.task.id);
      any = true;
    }
    if (any) visible.add(n.task.id);
    return any;
  };
  forest.forEach(walk);
  return { visible, direct };
}

export function slugSafe(s: string) {
  return s.replace(/[^\w-]+/g, '-');
}
