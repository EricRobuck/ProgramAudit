import { useMemo, useState, type KeyboardEvent } from 'react';
import type { FacultyMember, Section, Task, UserNames } from '../types';
import { formatDate, isOverdue, type TreeNode } from '../util';
import { ActionMenu, ProgressBar, StatusBadge } from './common';
import { AssigneeSelect } from './AssigneeSelect';

export interface TreeHandlers {
  onOpen: (taskId: number) => void;
  onToggle: (taskId: number) => void;
  onAssign: (task: Task, assigneeId: number | null) => void;
  onAddTask: (section: Section, parent: Task | null) => void;
  onMove: (task: Task, parentId: number | null, position: number) => void;
  onMoveTo: (task: Task) => void;
  onArchive: (task: Task) => void;
  onRestore: (task: Task) => void;
}

interface Row {
  node: TreeNode;
  parentId: number | null;
  siblings: TreeNode[];
  index: number;
  expanded: boolean;
  hasChildren: boolean;
}

export function TreePanel({
  section,
  label,
  roots,
  filter,
  collapsed,
  selectedId,
  canManage,
  writable,
  faculty,
  users,
  today,
  handlers,
  active,
  asTab,
  tabId,
}: {
  section: Section;
  label: string;
  roots: TreeNode[];
  filter: { visible: Set<number>; direct: Set<number> } | null;
  collapsed: Set<number>;
  selectedId: number | null;
  canManage: boolean;
  writable: boolean;
  faculty: FacultyMember[];
  users: UserNames;
  today: string;
  handlers: TreeHandlers;
  active: boolean;
  asTab: boolean;
  tabId: string;
}) {
  const [focusedId, setFocusedId] = useState<number | null>(null);

  const isVisible = (n: TreeNode) => !filter || filter.visible.has(n.task.id);
  // Active siblings only: moves are positioned among non-archived tasks.
  const activeKids = (list: TreeNode[]) => list.filter((n) => !n.task.archived);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (list: TreeNode[], parentId: number | null) => {
      const active = activeKids(list);
      for (const n of list) {
        if (!isVisible(n)) continue;
        const kids = n.children.filter(isVisible);
        const expanded = filter ? true : !collapsed.has(n.task.id);
        out.push({ node: n, parentId, siblings: active, index: active.indexOf(n), expanded, hasChildren: kids.length > 0 });
        if (expanded) walk(n.children, n.task.id);
      }
    };
    walk(roots, null);
    return out;
  }, [roots, filter, collapsed]); // eslint-disable-line react-hooks/exhaustive-deps

  const rowById = useMemo(() => new Map(rows.map((r) => [r.node.task.id, r])), [rows]);
  const sectionProgress = roots.reduce(
    (a, n) => ({ completed: a.completed + n.subtree.completed, total: a.total + n.subtree.total }),
    { completed: 0, total: 0 },
  );
  const effectiveFocus = rows.some((r) => r.node.task.id === focusedId) ? focusedId : (rows[0]?.node.task.id ?? null);

  const focusRow = (id: number) => {
    setFocusedId(id);
    document.getElementById(`treeitem-${id}`)?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>, row: Row) => {
    if (e.target !== e.currentTarget) return; // let inner controls handle their own keys
    const i = rows.indexOf(row);
    const id = row.node.task.id;
    switch (e.key) {
      case 'ArrowDown':
        if (rows[i + 1]) focusRow(rows[i + 1].node.task.id);
        break;
      case 'ArrowUp':
        if (rows[i - 1]) focusRow(rows[i - 1].node.task.id);
        break;
      case 'Home':
        if (rows[0]) focusRow(rows[0].node.task.id);
        break;
      case 'End':
        if (rows.length) focusRow(rows[rows.length - 1].node.task.id);
        break;
      case 'ArrowRight':
        if (row.hasChildren && !row.expanded) handlers.onToggle(id);
        else if (row.hasChildren && rows[i + 1]) focusRow(rows[i + 1].node.task.id);
        break;
      case 'ArrowLeft':
        if (row.hasChildren && row.expanded && !filter) handlers.onToggle(id);
        else if (row.parentId) focusRow(row.parentId);
        break;
      case 'Enter':
      case ' ':
        handlers.onOpen(id);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const renderRows = (list: TreeNode[], level: number, parentId: number | null) => {
    const visibleList = list.filter(isVisible);
    return visibleList.map((n, pos) => {
      const row = rowById.get(n.task.id);
      if (!row) return null;
      const t = n.task;
      const focused = effectiveFocus === t.id;
      const tab = focused ? 0 : -1;
      const overdue = isOverdue(t, today);
      const dimmed = filter && !filter.direct.has(t.id);
      const assigneeName = t.assigneeId ? (users[t.assigneeId]?.displayName ?? faculty.find((f) => f.id === t.assigneeId)?.displayName ?? '—') : 'Unassigned';
      const inactive = t.assigneeId && users[t.assigneeId] && !users[t.assigneeId].active;
      const canEditRow = canManage && writable && !t.archived;
      const menuItems = canManage && writable
        ? t.archived
          ? [{ label: 'Restore', onSelect: () => handlers.onRestore(t) }]
          : [
              { label: 'Open editor', onSelect: () => handlers.onOpen(t.id) },
              { label: 'Add subtask', onSelect: () => handlers.onAddTask(section, t) },
              { label: 'Move up', onSelect: () => handlers.onMove(t, parentId, row.index - 1), disabled: row.index <= 0 },
              { label: 'Move down', onSelect: () => handlers.onMove(t, parentId, row.index + 1), disabled: row.index < 0 || row.index >= row.siblings.length - 1 },
              { label: 'Move to…', onSelect: () => handlers.onMoveTo(t) },
              { label: 'Archive…', onSelect: () => handlers.onArchive(t), danger: true },
            ]
        : [];
      return (
        <li
          key={t.id}
          id={`treeitem-${t.id}`}
          role="treeitem"
          aria-level={level}
          aria-setsize={visibleList.length}
          aria-posinset={pos + 1}
          aria-expanded={row.hasChildren ? row.expanded : undefined}
          aria-selected={selectedId === t.id}
          aria-label={`${t.title}${t.archived ? ', archived' : ''}`}
          tabIndex={tab}
          className={`tree-item${t.archived ? ' is-archived' : ''}`}
          onKeyDown={(e) => onKeyDown(e, row)}
          onFocus={(e) => {
            if (e.target === e.currentTarget) setFocusedId(t.id);
          }}
        >
          <div className={`tree-row${selectedId === t.id ? ' is-selected' : ''}${dimmed ? ' is-context' : ''}`}>
            <span className="tree-indent" style={{ width: `${(level - 1) * 14}px` }} />
            {row.hasChildren ? (
              <button
                type="button"
                className="twisty"
                tabIndex={-1}
                aria-hidden="true"
                onClick={() => handlers.onToggle(t.id)}
                disabled={!!filter}
              >
                {row.expanded ? '▾' : '▸'}
              </button>
            ) : (
              <span className="twisty" aria-hidden="true" />
            )}
            <div className="tree-main">
              <button type="button" className="task-title" tabIndex={tab} onClick={() => handlers.onOpen(t.id)}>
                {t.title}
              </button>
              <div className="tree-meta">
                {t.archived ? <span className="badge badge-archived">Archived</span> : <StatusBadge status={t.status} overdue={overdue} />}
                {n.children.length > 0 && (
                  <span className="subtree-progress" title="Completed tasks in this branch, including this one">
                    <span className="sr-only">Branch: </span>
                    {n.subtree.completed}/{n.subtree.total} in branch
                  </span>
                )}
                {t.dueDate && <span className={`due${overdue ? ' is-overdue' : ''}`}>Due {formatDate(t.dueDate)}</span>}
                {canEditRow ? (
                  <AssigneeSelect
                    ariaLabel={`Assigned professor for ${t.title}`}
                    value={t.assigneeId}
                    faculty={faculty}
                    users={users}
                    tabIndex={tab}
                    onChange={(id) => handlers.onAssign(t, id)}
                  />
                ) : (
                  <span className="assignee">
                    <span className="sr-only">Assigned to </span>
                    {assigneeName}
                    {inactive && ' (inactive)'}
                  </span>
                )}
                {menuItems.length > 0 && <ActionMenu label={`Actions for ${t.title}`} items={menuItems} tabIndex={tab} />}
              </div>
            </div>
          </div>
          {row.hasChildren && row.expanded && (
            <ul role="group">{renderRows(n.children, level + 1, t.id)}</ul>
          )}
        </li>
      );
    });
  };

  const headingId = `section-${section}-heading`;
  return (
    <section
      className="tree-panel"
      aria-labelledby={asTab ? tabId : headingId}
      id={`panel-${section}`}
      role={asTab ? 'tabpanel' : undefined}
      hidden={asTab && !active}
    >
      <div className="tree-panel-head">
        <h2 id={headingId}>{label}</h2>
        <ProgressBar completed={sectionProgress.completed} total={sectionProgress.total} label={`${label} progress`} />
        {canManage && writable && (
          <button type="button" className="btn btn-small" onClick={() => handlers.onAddTask(section, null)}>
            + Add task<span className="sr-only"> to {label}</span>
          </button>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="empty">
          {filter ? 'No matching tasks in this section.' : canManage && writable ? 'No tasks yet. Use “Add task” to create one.' : 'No tasks in this section yet.'}
        </p>
      ) : (
        <ul role="tree" aria-labelledby={headingId} className="tree">
          {renderRows(roots, 1, null)}
        </ul>
      )}
    </section>
  );
}
