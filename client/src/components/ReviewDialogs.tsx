import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage } from '../api';
import { useUser } from '../auth';
import type { FacultyMember, Review, Section, Task } from '../types';
import { SECTIONS } from '../types';
import { formatDateTime } from '../util';
import { Dialog, ErrorBanner, useFormSubmit } from './common';

export function AddTaskDialog({
  reviewId,
  section,
  parent,
  onClose,
  onCreated,
}: {
  reviewId: number;
  section: Section;
  parent: Task | null;
  onClose: () => void;
  onCreated: (t: Task) => void | Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [instructions, setInstructions] = useState('');
  const [dueDate, setDueDate] = useState('');
  const { busy, error, submit } = useFormSubmit(
    () =>
      api.post<{ task: Task }>(`/reviews/${reviewId}/tasks`, {
        section,
        parentId: parent?.id ?? null,
        title,
        instructions,
        dueDate: dueDate || null,
      }),
    (r) => onCreated(r.task),
  );
  const sectionLabel = SECTIONS.find((s) => s.key === section)?.label;
  return (
    <Dialog open title={parent ? `Add subtask under “${parent.title}”` : `Add task to ${sectionLabel}`} onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <ErrorBanner error={error} />
        <label className="field">
          <span>Title (required)</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={300} autoFocus />
        </label>
        <label className="field">
          <span>Instructions for faculty (optional)</span>
          <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={3} />
        </label>
        <label className="field">
          <span>Due date (optional)</span>
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </label>
        <p className="hint">New tasks start unassigned. Choose a professor from the task’s dropdown afterward.</p>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !title.trim()}>
            {busy ? 'Adding…' : 'Add task'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function MoveDialog({ task, tasks, onClose, onMoved }: { task: Task; tasks: Task[]; onClose: () => void; onMoved: () => void | Promise<void> }) {
  const [section, setSection] = useState<Section>(task.section);
  const [parentId, setParentId] = useState<string>(task.parentId ? String(task.parentId) : '');
  const [where, setWhere] = useState<'end' | 'start'>('end');

  // Candidate parents: tasks in the chosen section, excluding this task and its descendants.
  const options = useMemo(() => {
    const kids = new Map<number | null, Task[]>();
    for (const t of tasks) {
      if (!kids.has(t.parentId)) kids.set(t.parentId, []);
      kids.get(t.parentId)!.push(t);
    }
    for (const l of kids.values()) l.sort((a, b) => a.sortOrder - b.sortOrder);
    const out: { id: number; label: string }[] = [];
    const walk = (pid: number | null, depth: number) => {
      for (const t of kids.get(pid) ?? []) {
        if (t.section !== section || t.id === task.id) continue;
        out.push({ id: t.id, label: `${'— '.repeat(depth)}${t.title}` });
        walk(t.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [tasks, section, task.id]);

  const siblingsCount = tasks.filter((t) => t.section === section && t.id !== task.id && (parentId ? t.parentId === Number(parentId) : !t.parentId)).length;
  const { busy, error, submit } = useFormSubmit(
    () =>
      api.post(`/tasks/${task.id}/move`, {
        section,
        parentId: parentId ? Number(parentId) : null,
        position: where === 'start' ? 0 : siblingsCount,
      }),
    () => onMoved(),
  );
  return (
    <Dialog open title={`Move “${task.title}”`} onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <p className="hint">The task moves with all of its subtasks. Responses, assignments and history are kept.</p>
        <ErrorBanner error={error} />
        <label className="field">
          <span>Section</span>
          <select
            value={section}
            onChange={(e) => {
              setSection(e.target.value as Section);
              setParentId('');
            }}
          >
            {SECTIONS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Place under</span>
          <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">(Top level of section)</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="field">
          <legend>Position among siblings</legend>
          <label className="check">
            <input type="radio" name="where" checked={where === 'start'} onChange={() => setWhere('start')} /> First
          </label>
          <label className="check">
            <input type="radio" name="where" checked={where === 'end'} onChange={() => setWhere('end')} /> Last
          </label>
        </fieldset>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Moving…' : 'Move'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function ArchiveDialog({ task, onClose, onArchived }: { task: Task; onClose: () => void; onArchived: (n: number) => void | Promise<void> }) {
  const [count, setCount] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    api
      .get<{ descendantCount: number }>(`/tasks/${task.id}/archive-preview`)
      .then((r) => setCount(r.descendantCount))
      .catch((e) => setLoadError(errorMessage(e)));
  }, [task.id]);
  const { busy, error, submit } = useFormSubmit(
    () => api.post<{ archivedCount: number }>(`/tasks/${task.id}/archive`),
    (r) => onArchived(r.archivedCount),
  );
  return (
    <Dialog open title="Archive task?" onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <ErrorBanner error={loadError ?? error} />
        {count === null ? (
          <p>Checking subtasks…</p>
        ) : (
          <p>
            Archive “{task.title}”
            {count > 0 ? (
              <>
                {' '}
                and its <strong>{count}</strong> {count === 1 ? 'subtask' : 'subtasks'}
              </>
            ) : null}
            ? Archived tasks are hidden from progress and new reports. Nothing is deleted: written responses and history are kept, and you can restore
            them later.
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-danger" disabled={busy || count === null}>
            {busy ? 'Archiving…' : `Archive ${count !== null ? count + 1 : ''} ${count === 0 ? 'task' : 'tasks'}`}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function ReviewFormDialog({
  open,
  majorId,
  review,
  onClose,
  onSaved,
}: {
  open: boolean;
  majorId: number | null;
  review?: Review;
  onClose: () => void;
  onSaved: (r: Review) => void | Promise<void>;
}) {
  const [title, setTitle] = useState(review?.title ?? '');
  const [period, setPeriod] = useState(review?.period ?? '');
  const [description, setDescription] = useState(review?.description ?? '');
  const [archiveError, setArchiveError] = useState<string | null>(null);
  useEffect(() => {
    if (open && !review) {
      setTitle('');
      setPeriod('');
      setDescription('');
    }
  }, [open, review]);
  const { busy, error, submit } = useFormSubmit(
    async () =>
      review
        ? (await api.patch<{ review: Review }>(`/reviews/${review.id}`, { title, period, description })).review
        : (await api.post<{ review: Review }>('/reviews', { majorId, title, period, description })).review,
    onSaved,
  );
  const toggleArchive = async () => {
    if (!review) return;
    const msg = review.archived
      ? 'Reopen this review? It will become editable again.'
      : 'Archive this review? It becomes read-only for everyone until reopened. Nothing is deleted.';
    if (!window.confirm(msg)) return;
    try {
      const r = await api.patch<{ review: Review }>(`/reviews/${review.id}`, { archived: !review.archived });
      await onSaved(r.review);
    } catch (e) {
      setArchiveError(errorMessage(e));
    }
  };
  return (
    <Dialog open={open} title={review ? 'Review settings' : 'New review'} onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <ErrorBanner error={error ?? archiveError} />
        <label className="field">
          <span>Title (required)</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} placeholder="e.g. 2026 Program Review" disabled={review?.archived} />
        </label>
        <label className="field">
          <span>Period or academic year (optional)</span>
          <input value={period} onChange={(e) => setPeriod(e.target.value)} maxLength={100} placeholder="e.g. 2021–2026" disabled={review?.archived} />
        </label>
        <label className="field">
          <span>Description (optional)</span>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} disabled={review?.archived} />
        </label>
        {!review && <p className="hint">Every review starts with three sections: Past, Present and Future.</p>}
        <div className="dialog-actions">
          {review && (
            <button type="button" className={review.archived ? 'btn' : 'btn btn-danger-outline'} onClick={() => void toggleArchive()}>
              {review.archived ? 'Reopen review' : 'Archive review'}
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          {!review?.archived && (
            <button type="submit" className="btn btn-primary" disabled={busy || !title.trim()}>
              {busy ? 'Saving…' : review ? 'Save' : 'Create review'}
            </button>
          )}
        </div>
      </form>
    </Dialog>
  );
}

interface AccessRow {
  userId: number;
  displayName: string;
  role: string;
  active: boolean;
  access: 'coordinator' | 'faculty';
}

export function ParticipantsDialog({ review, faculty, onClose }: { review: Review; faculty: FacultyMember[]; onClose: () => void }) {
  const user = useUser();
  const [rows, setRows] = useState<AccessRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addId, setAddId] = useState('');
  const [addAs, setAddAs] = useState<'faculty' | 'coordinator'>('faculty');
  const load = () =>
    api
      .get<{ access: AccessRow[] }>(`/reviews/${review.id}/access`)
      .then((r) => setRows(r.access))
      .catch((e) => setError(errorMessage(e)));
  useEffect(() => {
    void load();
  }, [review.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const present = new Set(rows?.map((r) => r.userId));
  const candidates = faculty.filter((f) => f.active && !present.has(f.id) && (addAs === 'faculty' ? true : f.role === 'coordinator'));
  const writable = !review.archived;

  return (
    <Dialog open title="Review participants" onClose={onClose}>
      <ErrorBanner error={error} />
      <p className="hint">Faculty assigned to a task are added automatically. Participants can read this review’s tasks and preview its report.</p>
      {rows && (
        <table className="table">
          <caption className="sr-only">People with access</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Access</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.userId}>
                <td>
                  {r.displayName}
                  {!r.active && ' (inactive)'}
                </td>
                <td>{r.access === 'coordinator' ? 'Coordinator' : 'Faculty'}</td>
                <td>
                  {writable && (r.access === 'faculty' || user.role === 'admin') && (
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() => void act(() => api.del(`/reviews/${review.id}/access/${r.userId}`))}
                    >
                      Remove<span className="sr-only"> {r.displayName}</span>
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {writable && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (addId) void act(() => api.put(`/reviews/${review.id}/access/${addId}`, { access: addAs })).then(() => setAddId(''));
          }}
        >
          <label className="field field-inline">
            <span>Add person</span>
            <select value={addId} onChange={(e) => setAddId(e.target.value)}>
              <option value="">Choose…</option>
              {candidates.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.displayName}
                </option>
              ))}
            </select>
          </label>
          {user.role === 'admin' && (
            <label className="field field-inline">
              <span>As</span>
              <select value={addAs} onChange={(e) => setAddAs(e.target.value as 'faculty' | 'coordinator')}>
                <option value="faculty">Faculty</option>
                <option value="coordinator">Coordinator</option>
              </select>
            </label>
          )}
          <button type="submit" className="btn" disabled={!addId}>
            Add
          </button>
        </form>
      )}
    </Dialog>
  );
}

const ACTION_LABELS: Record<string, string> = {
  'task.create': 'Created task',
  'task.update': 'Edited task details',
  'task.assign': 'Changed assignment',
  'task.move': 'Moved task',
  'task.archive': 'Archived task',
  'task.restore': 'Restored task',
  'response.save': 'Saved response',
  'response.restore': 'Restored earlier response',
  'task.complete': 'Marked complete',
  'task.reopen': 'Reopened task',
  'report.generate': 'Generated report snapshot',
  'review.create': 'Created review',
  'review.update': 'Edited review',
  'review.archive': 'Archived review',
  'review.reopen': 'Reopened review',
  'review.access.grant': 'Granted access',
  'review.access.revoke': 'Removed access',
};

export function ActivityDialog({ reviewId, onClose }: { reviewId: number; onClose: () => void }) {
  const user = useUser();
  const [rows, setRows] = useState<{ id: number; action: string; createdAt: string; taskTitle: string | null; actor: string | null }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .get<{ activity: NonNullable<typeof rows> }>(`/reviews/${reviewId}/activity`)
      .then((r) => setRows(r.activity))
      .catch((e) => setError(errorMessage(e)));
  }, [reviewId]);
  return (
    <Dialog open title="Recent activity" onClose={onClose} wide>
      <ErrorBanner error={error} />
      {rows && rows.length === 0 && <p className="muted">No activity yet.</p>}
      {rows && rows.length > 0 && (
        <table className="table table-compact">
          <caption className="sr-only">Most recent 200 actions</caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Who</th>
              <th scope="col">Action</th>
              <th scope="col">Task</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{formatDateTime(r.createdAt, user.timezone)}</td>
                <td>{r.actor ?? '—'}</td>
                <td>{ACTION_LABELS[r.action] ?? r.action}</td>
                <td>{r.taskTitle ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Dialog>
  );
}
