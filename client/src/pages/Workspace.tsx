import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { useUser } from '../auth';
import { ErrorBanner, ProgressBar } from '../components/common';
import { TaskEditor } from '../components/TaskEditor';
import { TreePanel, type TreeHandlers } from '../components/TreePanel';
import { AddTaskDialog, ArchiveDialog, MoveDialog, ReviewFormDialog, ParticipantsDialog, ActivityDialog } from '../components/ReviewDialogs';
import type { Curriculum, FacultyMember, Major, Review, Section, Status, Task, UserNames } from '../types';
import { SECTIONS } from '../types';
import { buildForest, filterTree, isOverdue, todayIn } from '../util';

interface Catalog {
  curricula: Curriculum[];
  majors: Major[];
  reviews: Review[];
}

export function WorkspacePage() {
  const user = useUser();
  const [params, setParams] = useSearchParams();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newReviewOpen, setNewReviewOpen] = useState(false);

  const c = Number(params.get('c')) || null;
  const m = Number(params.get('m')) || null;
  const r = Number(params.get('r')) || null;

  const loadCatalog = useCallback(async () => {
    try {
      setError(null);
      setCatalog(await api.get<Catalog>('/catalog'));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const majors = useMemo(() => catalog?.majors.filter((x) => x.curriculumId === c) ?? [], [catalog, c]);
  const reviews = useMemo(() => catalog?.reviews.filter((x) => x.majorId === m) ?? [], [catalog, m]);

  // Drop stale or incompatible selections (FR-03).
  useEffect(() => {
    if (!catalog) return;
    const next = new URLSearchParams(params);
    let changed = false;
    if (c && !catalog.curricula.some((x) => x.id === c)) {
      ['c', 'm', 'r', 'task'].forEach((k) => next.delete(k));
      changed = true;
    } else if (m && !majors.some((x) => x.id === m)) {
      ['m', 'r', 'task'].forEach((k) => next.delete(k));
      changed = true;
    } else if (r && !reviews.some((x) => x.id === r)) {
      ['r', 'task'].forEach((k) => next.delete(k));
      changed = true;
    } else if (m && !r && reviews.length === 1) {
      // Select the review automatically when it is the only one for this major.
      next.set('r', String(reviews[0].id));
      changed = true;
    } else if (!c && catalog.curricula.length === 1) {
      next.set('c', String(catalog.curricula[0].id));
      changed = true;
    } else if (c && !m && majors.length === 1) {
      next.set('m', String(majors[0].id));
      changed = true;
    }
    if (changed) setParams(next, { replace: true });
  }, [catalog, c, m, r, majors, reviews, params, setParams]);

  const select = (key: 'c' | 'm' | 'r', value: string) => {
    const next = new URLSearchParams();
    if (key === 'c') {
      if (value) next.set('c', value);
    } else if (key === 'm') {
      if (c) next.set('c', String(c));
      if (value) next.set('m', value);
    } else {
      if (c) next.set('c', String(c));
      if (m) next.set('m', String(m));
      if (value) next.set('r', value);
    }
    setParams(next);
  };

  const canCreateReview = user.role !== 'professor' && !!m && !majors.find((x) => x.id === m)?.archived;
  const review = reviews.find((x) => x.id === r) ?? null;

  return (
    <div className="workspace">
      <div className="selection-bar" role="group" aria-label="Choose a review">
        <div className="field field-inline">
          <label htmlFor="sel-curriculum">Curriculum</label>
          <select id="sel-curriculum" value={c ?? ''} onChange={(e) => select('c', e.target.value)} disabled={!catalog}>
            <option value="">{catalog && catalog.curricula.length === 0 ? 'No curricula available' : 'Select a curriculum…'}</option>
            {catalog?.curricula.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
                {x.archived ? ' (archived)' : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="field field-inline">
          <label htmlFor="sel-major">Major</label>
          <select id="sel-major" value={m ?? ''} onChange={(e) => select('m', e.target.value)} disabled={!c}>
            <option value="">{!c ? 'Select a curriculum first' : majors.length === 0 ? 'No majors in this curriculum' : 'Select a major…'}</option>
            {majors.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
                {x.archived ? ' (archived)' : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="field field-inline">
          <label htmlFor="sel-review">Review</label>
          <select id="sel-review" value={r ?? ''} onChange={(e) => select('r', e.target.value)} disabled={!m}>
            <option value="">{!m ? 'Select a major first' : reviews.length === 0 ? 'No reviews for this major' : 'Select a review…'}</option>
            {reviews.map((x) => (
              <option key={x.id} value={x.id}>
                {x.title}
                {x.period ? ` (${x.period})` : ''}
                {x.archived ? ' — archived' : ''}
              </option>
            ))}
          </select>
        </div>
        {canCreateReview && (
          <button type="button" className="btn" onClick={() => setNewReviewOpen(true)}>
            + New review
          </button>
        )}
      </div>
      <ErrorBanner error={error} onRetry={loadCatalog} />

      {catalog && !review && (
        <div className="empty-state">
          {catalog.curricula.length === 0 ? (
            user.role === 'admin' ? (
              <p>
                No curricula exist yet. <Link to="/admin">Create a curriculum and major</Link> to begin.
              </p>
            ) : user.role === 'professor' ? (
              <p>You have not been added to any reviews yet. A review coordinator will assign you tasks.</p>
            ) : (
              <p>No curricula exist yet. Ask an administrator to set up curricula and majors.</p>
            )
          ) : !c ? (
            <p>Choose a curriculum, then a major and review, to see its Past, Present and Future task trees.</p>
          ) : !m ? (
            <p>{majors.length === 0 ? 'This curriculum has no majors yet.' : 'Choose a major.'}</p>
          ) : reviews.length === 0 ? (
            <p>
              This major has no reviews yet.
              {canCreateReview && ' Use “New review” to start one.'}
            </p>
          ) : (
            <p>Choose a review.</p>
          )}
        </div>
      )}

      {review && <ReviewWorkspace key={review.id} review={review} onReviewChanged={loadCatalog} />}

      <ReviewFormDialog
        open={newReviewOpen}
        majorId={m}
        onClose={() => setNewReviewOpen(false)}
        onSaved={async (rv) => {
          setNewReviewOpen(false);
          await loadCatalog();
          select('r', String(rv.id));
        }}
      />
    </div>
  );
}

type StatusFilter = 'all' | Status | 'overdue' | 'unassigned';

function ReviewWorkspace({ review, onReviewChanged }: { review: Review; onReviewChanged: () => Promise<void> }) {
  const user = useUser();
  const [params, setParams] = useSearchParams();
  const openTaskId = Number(params.get('task')) || null;
  const canManage = review.myAccess === 'admin' || review.myAccess === 'coordinator';
  const writable = !review.archived;

  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [users, setUsers] = useState<UserNames>({});
  const [faculty, setFaculty] = useState<FacultyMember[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [assigneeFilter, setAssigneeFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [query, setQuery] = useState('');
  const [searchIds, setSearchIds] = useState<Set<number> | null>(null);
  const sectionKey = `pa.section.${review.id}`;
  const [activeSection, setActiveSectionRaw] = useState<Section>(() => {
    try {
      const v = localStorage.getItem(sectionKey);
      return v === 'past' || v === 'present' || v === 'future' ? v : 'past';
    } catch {
      return 'past';
    }
  });
  const setActiveSection = useCallback(
    (sec: Section) => {
      setActiveSectionRaw(sec);
      try {
        localStorage.setItem(sectionKey, sec);
      } catch {
        /* storage unavailable */
      }
    },
    [sectionKey],
  );
  const today = todayIn(user.timezone);

  const storageKey = `pa.collapsed.${review.id}`;
  const [collapsed, setCollapsed] = useState<Set<number>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(storageKey) ?? '[]'));
    } catch {
      return new Set();
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify([...collapsed]));
    } catch {
      /* storage unavailable */
    }
  }, [collapsed, storageKey]);

  const [dialog, setDialog] = useState<
    | { kind: 'add'; section: Section; parent: Task | null }
    | { kind: 'move'; task: Task }
    | { kind: 'archive'; task: Task }
    | { kind: 'edit-review' }
    | { kind: 'participants' }
    | { kind: 'activity' }
    | null
  >(null);

  const loadTree = useCallback(async () => {
    try {
      const t = await api.get<{ tasks: Task[]; users: UserNames }>(`/reviews/${review.id}/tree${showArchived ? '?includeArchived=1' : ''}`);
      setTasks(t.tasks);
      setUsers((u) => ({ ...u, ...t.users }));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [review.id, showArchived]);

  useEffect(() => {
    void loadTree();
  }, [loadTree]);
  useEffect(() => {
    if (!canManage) return;
    api
      .get<{ faculty: FacultyMember[] }>('/faculty')
      .then((f) => {
        setFaculty(f.faculty);
        setUsers((u) => ({ ...Object.fromEntries(f.faculty.map((x) => [x.id, { displayName: x.displayName, active: x.active }])), ...u }));
      })
      .catch(() => undefined);
  }, [canManage]);

  // Server-side search over titles and narrative text (debounced).
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setSearchIds(null);
      return;
    }
    const h = window.setTimeout(() => {
      api
        .get<{ taskIds: number[] }>(`/reviews/${review.id}/search?q=${encodeURIComponent(q)}`)
        .then((r) => setSearchIds(new Set(r.taskIds)))
        .catch((e) => setError(errorMessage(e)));
    }, 300);
    return () => window.clearTimeout(h);
  }, [query, review.id]);

  const forest = useMemo(() => buildForest(tasks ?? []), [tasks]);
  const activeTasks = useMemo(() => (tasks ?? []).filter((t) => !t.archived), [tasks]);
  const counts = useMemo(
    () => ({
      total: activeTasks.length,
      unassigned: activeTasks.filter((t) => !t.assigneeId).length,
      not_started: activeTasks.filter((t) => t.status === 'not_started').length,
      in_progress: activeTasks.filter((t) => t.status === 'in_progress').length,
      complete: activeTasks.filter((t) => t.status === 'complete').length,
      overdue: activeTasks.filter((t) => isOverdue(t, today)).length,
    }),
    [activeTasks, today],
  );

  const filterActive = assigneeFilter !== 'all' || statusFilter !== 'all' || searchIds !== null;
  const filters = useMemo(() => {
    if (!filterActive) return null;
    const match = (t: Task) =>
      (assigneeFilter === 'all' || (assigneeFilter === 'unassigned' ? !t.assigneeId : t.assigneeId === Number(assigneeFilter))) &&
      (statusFilter === 'all' ||
        (statusFilter === 'overdue' ? isOverdue(t, today) : statusFilter === 'unassigned' ? !t.assigneeId : t.status === statusFilter)) &&
      (!searchIds || searchIds.has(t.id));
    return {
      past: filterTree(forest.past, match),
      present: filterTree(forest.present, match),
      future: filterTree(forest.future, match),
    };
  }, [filterActive, assigneeFilter, statusFilter, searchIds, forest, today]);
  const matchCount = filters ? filters.past.direct.size + filters.present.direct.size + filters.future.direct.size : null;

  const sectionProgress = useMemo(() => {
    const sum = (list: typeof forest.past) =>
      list.reduce((a, n) => ({ completed: a.completed + n.subtree.completed, total: a.total + n.subtree.total }), { completed: 0, total: 0 });
    return { past: sum(forest.past), present: sum(forest.present), future: sum(forest.future) };
  }, [forest]);

  // Show the section that contains the task being opened (e.g. from My Tasks or a link).
  useEffect(() => {
    if (!openTaskId || !tasks) return;
    const t = tasks.find((x) => x.id === openTaskId);
    if (t && t.section !== activeSection) setActiveSection(t.section);
  }, [openTaskId, tasks]); // eslint-disable-line react-hooks/exhaustive-deps

  // When a filter has no matches in the current section, switch to one that does.
  useEffect(() => {
    if (!filters || filters[activeSection].direct.size > 0) return;
    const other = SECTIONS.find((x) => filters[x.key].direct.size > 0);
    if (other) setActiveSection(other.key);
  }, [filters]); // eslint-disable-line react-hooks/exhaustive-deps

  const replaceTask = useCallback((t: Task) => {
    setTasks((list) => (list ? list.map((x) => (x.id === t.id ? { ...x, ...t, wordCount: t.wordCount ?? x.wordCount } : x)) : list));
  }, []);

  const openTask = (id: number | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('task', String(id));
    else next.delete('task');
    setParams(next);
  };

  const run = async (fn: () => Promise<unknown>, success?: string) => {
    setNotice(null);
    try {
      await fn();
      if (success) setNotice(success);
      await loadTree();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const handlers: TreeHandlers = {
    onOpen: (id) => openTask(id),
    onToggle: (id) =>
      setCollapsed((s) => {
        const n = new Set(s);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      }),
    onAssign: (t, id) =>
      void run(async () => {
        const r = await api.put<{ task: Task }>(`/tasks/${t.id}/assignee`, { assigneeId: id });
        replaceTask(r.task);
      }, `Assignment updated for “${t.title}”.`),
    onAddTask: (section, parent) => setDialog({ kind: 'add', section, parent }),
    onMove: (t, parentId, position) =>
      void run(() => api.post(`/tasks/${t.id}/move`, { section: t.section, parentId, position }), `Moved “${t.title}”.`),
    onMoveTo: (t) => setDialog({ kind: 'move', task: t }),
    onArchive: (t) => setDialog({ kind: 'archive', task: t }),
    onRestore: (t) => void run(() => api.post(`/tasks/${t.id}/restore`), `Restored “${t.title}”.`),
  };

  const facultyInReview = useMemo(() => {
    const ids = new Set(activeTasks.map((t) => t.assigneeId).filter((x): x is number => !!x));
    return [...ids].map((id) => ({ id, name: users[id]?.displayName ?? `User ${id}` })).sort((a, b) => a.name.localeCompare(b.name));
  }, [activeTasks, users]);

  return (
    <div className={`review-workspace${openTaskId ? ' has-drawer' : ''}`}>
      <div className="review-header">
        <div>
          <h1>
            {review.title}
            {review.archived && <span className="badge badge-archived">Archived — read-only</span>}
          </h1>
          {(review.period || review.description) && (
            <p className="muted">
              {review.period}
              {review.period && review.description && ' · '}
              {review.description}
            </p>
          )}
          <div className="review-progress">
            <strong>Review progress:</strong> <ProgressBar completed={counts.complete} total={counts.total} label="Review progress" />
          </div>
        </div>
        <div className="review-actions">
          <Link className="btn btn-primary" to={`/reviews/${review.id}/report`}>
            {canManage ? 'Reports' : 'Report preview'}
          </Link>
          {canManage && (
            <>
              <button type="button" className="btn" onClick={() => setDialog({ kind: 'participants' })}>
                Participants
              </button>
              <button type="button" className="btn" onClick={() => setDialog({ kind: 'activity' })}>
                Activity
              </button>
              <button type="button" className="btn" onClick={() => setDialog({ kind: 'edit-review' })}>
                Review settings
              </button>
            </>
          )}
        </div>
      </div>

      <div className="filters" role="search" aria-label="Filter tasks">
        <ul className="count-chips" aria-label="Task counts">
          {(
            [
              ['unassigned', 'Unassigned', counts.unassigned],
              ['not_started', 'Not started', counts.not_started],
              ['in_progress', 'In progress', counts.in_progress],
              ['complete', 'Complete', counts.complete],
              ['overdue', 'Overdue', counts.overdue],
            ] as const
          ).map(([key, label, n]) => (
            <li key={key}>
              <button
                type="button"
                className={`chip chip-${key}${statusFilter === key ? ' is-on' : ''}`}
                aria-pressed={statusFilter === key}
                onClick={() => setStatusFilter(statusFilter === key ? 'all' : key)}
              >
                {label}: <strong>{n}</strong>
              </button>
            </li>
          ))}
        </ul>
        <div className="filter-controls">
          <div className="field field-inline">
          <label htmlFor="filter-professor">Professor</label>
          <select id="filter-professor" value={assigneeFilter} onChange={(e) => setAssigneeFilter(e.target.value)}>
              <option value="all">All</option>
              <option value="unassigned">Unassigned</option>
              {facultyInReview.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field field-inline">
          <label htmlFor="filter-status">Status</label>
          <select id="filter-status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}>
              <option value="all">All</option>
              <option value="not_started">Not started</option>
              <option value="in_progress">In progress</option>
              <option value="complete">Complete</option>
              <option value="overdue">Overdue</option>
              <option value="unassigned">Unassigned</option>
            </select>
          </div>
          <div className="field field-inline field-grow">
          <label htmlFor="filter-search">Search</label>
          <input id="filter-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Task titles and narrative text" />
          </div>
          {canManage && (
            <label className="check">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived
            </label>
          )}
          {filterActive && (
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => {
                setAssigneeFilter('all');
                setStatusFilter('all');
                setQuery('');
              }}
            >
              Clear filters
            </button>
          )}
        </div>
        <p className="sr-only" role="status" aria-live="polite">
          {matchCount !== null ? `${matchCount} matching tasks` : ''}
        </p>
        {matchCount !== null && (
          <p className="muted filter-summary">
            {matchCount} matching {matchCount === 1 ? 'task' : 'tasks'}. Parent tasks are shown dimmed for context.
          </p>
        )}
      </div>

      <ErrorBanner error={error} onRetry={loadTree} />
      {notice && (
        <p className="alert alert-ok" role="status">
          {notice}
        </p>
      )}

      {tasks === null ? (
        <p className="page-loading">Loading tasks…</p>
      ) : (
        <>
          <div className="section-bar">
            <div className="field field-inline">
              <label htmlFor="sel-section">Section</label>
              <select id="sel-section" value={activeSection} onChange={(e) => setActiveSection(e.target.value as Section)}>
                {SECTIONS.map((s) => {
                  const p = sectionProgress[s.key];
                  const matches = filters ? filters[s.key].direct.size : null;
                  return (
                    <option key={s.key} value={s.key}>
                      {s.label}
                      {matches !== null ? ` — ${matches} matching` : p.total === 0 ? ' — no tasks' : ` — ${p.completed}/${p.total} complete`}
                    </option>
                  );
                })}
              </select>
            </div>
            <span className="muted small">Use Move to… on a task to place it in another section.</span>
          </div>
          <div className="tree-panels">
            <TreePanel
              key={activeSection}
              section={activeSection}
              label={SECTIONS.find((x) => x.key === activeSection)!.label}
              roots={forest[activeSection]}
              filter={filters ? filters[activeSection] : null}
              collapsed={collapsed}
              selectedId={openTaskId}
              canManage={canManage}
              writable={writable}
              faculty={faculty}
              users={users}
              today={today}
              handlers={handlers}
              active
              asTab={false}
              tabId={`sel-section`}
            />
          </div>
        </>
      )}

      {openTaskId && (
        <TaskEditor
          key={openTaskId}
          taskId={openTaskId}
          faculty={faculty}
          onClose={() => openTask(null)}
          onTaskChanged={replaceTask}
        />
      )}

      {dialog?.kind === 'add' && (
        <AddTaskDialog
          reviewId={review.id}
          section={dialog.section}
          parent={dialog.parent}
          onClose={() => setDialog(null)}
          onCreated={async (t) => {
            setDialog(null);
            if (dialog.parent) setCollapsed((s) => new Set([...s].filter((x) => x !== dialog.parent!.id)));
            await loadTree();
            setNotice(`Added “${t.title}”.`);
          }}
        />
      )}
      {dialog?.kind === 'move' && tasks && (
        <MoveDialog
          task={dialog.task}
          tasks={tasks.filter((t) => !t.archived)}
          onClose={() => setDialog(null)}
          onMoved={async () => {
            setDialog(null);
            await loadTree();
            setNotice(`Moved “${dialog.task.title}”.`);
          }}
        />
      )}
      {dialog?.kind === 'archive' && (
        <ArchiveDialog
          task={dialog.task}
          onClose={() => setDialog(null)}
          onArchived={async (n) => {
            setDialog(null);
            if (openTaskId) openTask(null);
            await loadTree();
            setNotice(`Archived ${n} ${n === 1 ? 'task' : 'tasks'}. Turn on “Show archived” to restore.`);
          }}
        />
      )}
      {dialog?.kind === 'edit-review' && (
        <ReviewFormDialog
          open
          majorId={review.majorId}
          review={review}
          onClose={() => setDialog(null)}
          onSaved={async () => {
            setDialog(null);
            await onReviewChanged();
          }}
        />
      )}
      {dialog?.kind === 'participants' && <ParticipantsDialog review={review} faculty={faculty} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'activity' && <ActivityDialog reviewId={review.id} onClose={() => setDialog(null)} />}
    </div>
  );
}
