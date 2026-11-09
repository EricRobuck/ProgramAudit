import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { Editor } from '@tiptap/react';
import { api, ApiError, errorMessage } from '../api';
import { useUser } from '../auth';
import { registerGuard } from '../guard';
import type { FacultyMember, Major, Curriculum, Review, ResponseRevision, Task, UserNames } from '../types';
import { SECTIONS } from '../types';
import { formatDate, formatDateTime, isOverdue, todayIn } from '../util';
import { ErrorBanner, StatusBadge } from './common';
import { countWords, hasVisibleText, RichEditor } from './RichEditor';
import { AssigneeSelect } from './AssigneeSelect';

interface TaskDetail {
  task: Task;
  path: { id: number; title: string }[];
  response: ResponseRevision;
  review: Review;
  major: Pick<Major, 'id' | 'name'>;
  curriculum: Pick<Curriculum, 'id' | 'name'>;
  users: UserNames;
  permissions: { canManage: boolean; canEdit: boolean; canComplete: boolean; canReopen: boolean; canViewHistory: boolean };
}

type SaveState = 'saved' | 'dirty' | 'saving' | 'failed' | 'conflict';

export function TaskEditor({
  taskId,
  faculty,
  onClose,
  onTaskChanged,
}: {
  taskId: number;
  faculty: FacultyMember[];
  onClose: () => void;
  onTaskChanged: (t: Task) => void;
}) {
  const user = useUser();
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadKey, setLoadKey] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const headingId = useId();

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const d = await api.get<TaskDetail>(`/tasks/${taskId}`);
      setDetail(d);
      setLoadKey((k) => k + 1);
      onTaskChanged(d.task);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, [taskId, onTaskChanged]);

  useEffect(() => {
    setDetail(null);
    void load();
  }, [load]);

  useEffect(() => {
    if (detail) headingRef.current?.focus();
  }, [detail?.task.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateTask = (t: Task) => {
    setDetail((d) => (d ? { ...d, task: t } : d));
    onTaskChanged(t);
  };

  return (
    <section
      className="drawer"
      aria-labelledby={headingId}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !(e.target as HTMLElement).closest('.menu, dialog')) onClose();
      }}
    >
      <div className="drawer-head">
        <h2 id={headingId} ref={headingRef} tabIndex={-1}>
          {detail ? detail.task.title : 'Loading task…'}
        </h2>
        <button type="button" className="btn btn-quiet" onClick={onClose}>
          Close <span className="sr-only">task editor</span>
        </button>
      </div>
      <ErrorBanner error={loadError} onRetry={load} />
      {detail && (
        <div className="drawer-body">
          <nav aria-label="Task location" className="breadcrumb">
            <ol>
              <li>{detail.curriculum.name}</li>
              <li>{detail.major.name}</li>
              <li>{detail.review.title}</li>
              <li>{SECTIONS.find((s) => s.key === detail.task.section)?.label}</li>
              {detail.path.map((p) => (
                <li key={p.id} aria-current={p.id === detail.task.id ? 'page' : undefined}>
                  {p.title}
                </li>
              ))}
            </ol>
          </nav>

          {detail.task.archived && <p className="alert alert-warn">This task is archived and read-only.</p>}
          {detail.review.archived && <p className="alert alert-warn">This review is archived and read-only.</p>}

          <TaskMeta detail={detail} faculty={faculty} onUpdated={updateTask} />

          <NarrativeSection
            key={`${detail.task.id}-${loadKey}`}
            detail={detail}
            timezone={user.timezone}
            onTaskChanged={updateTask}
            reload={load}
          />
        </div>
      )}
    </section>
  );
}

function TaskMeta({ detail, faculty, onUpdated }: { detail: TaskDetail; faculty: FacultyMember[]; onUpdated: (t: Task) => void }) {
  const user = useUser();
  const { task, permissions, users } = detail;
  const writable = permissions.canManage && !task.archived && !detail.review.archived;
  const [title, setTitle] = useState(task.title);
  const [instructions, setInstructions] = useState(task.instructions);
  const [dueDate, setDueDate] = useState(task.dueDate ?? '');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const changed = title !== task.title || instructions !== task.instructions || (dueDate || null) !== task.dueDate;
  const overdue = isOverdue(task, todayIn(user.timezone));

  useEffect(() => {
    setTitle(task.title);
    setInstructions(task.instructions);
    setDueDate(task.dueDate ?? '');
  }, [task.id, task.title, task.instructions, task.dueDate]);

  const saveDetails = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.patch<{ task: Task }>(`/tasks/${task.id}`, { title, instructions, dueDate: dueDate || null });
      onUpdated({ ...task, ...r.task, wordCount: task.wordCount });
      setMsg({ kind: 'ok', text: 'Task details saved.' });
    } catch (err) {
      setMsg({ kind: 'error', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const assign = async (assigneeId: number | null) => {
    setMsg(null);
    try {
      const r = await api.put<{ task: Task }>(`/tasks/${task.id}/assignee`, { assigneeId });
      onUpdated({ ...task, ...r.task, wordCount: task.wordCount });
    } catch (err) {
      setMsg({ kind: 'error', text: errorMessage(err) });
    }
  };

  const assigneeName = task.assigneeId ? users[task.assigneeId]?.displayName ?? faculty.find((f) => f.id === task.assigneeId)?.displayName : null;

  return (
    <div className="task-meta">
      <dl className="meta-grid">
        <div>
          <dt>Status</dt>
          <dd>
            <StatusBadge status={task.status} overdue={overdue} />
          </dd>
        </div>
        <div>
          <dt id={`assignee-label-${task.id}`}>Assigned professor</dt>
          <dd>
            {writable ? (
              <AssigneeSelect
                labelledBy={`assignee-label-${task.id}`}
                value={task.assigneeId}
                faculty={faculty}
                users={users}
                onChange={assign}
              />
            ) : (
              <span>
                {assigneeName ?? 'Unassigned'}
                {task.assigneeId && users[task.assigneeId] && !users[task.assigneeId].active && ' (inactive)'}
              </span>
            )}
          </dd>
        </div>
        {!writable && (
          <div>
            <dt>Due date</dt>
            <dd>{task.dueDate ? formatDate(task.dueDate) : 'None'}</dd>
          </div>
        )}
        {task.status === 'complete' && task.completedAt && (
          <div>
            <dt>Completed</dt>
            <dd>
              {formatDateTime(task.completedAt, user.timezone)}
              {task.completedBy && users[task.completedBy] && ` by ${users[task.completedBy].displayName}`}
            </dd>
          </div>
        )}
        {task.reopenedAt && task.status !== 'complete' && (
          <div>
            <dt>Reopened</dt>
            <dd>
              {formatDateTime(task.reopenedAt, user.timezone)}
              {task.reopenedBy && users[task.reopenedBy] && ` by ${users[task.reopenedBy].displayName}`}
            </dd>
          </div>
        )}
      </dl>

      {writable ? (
        <form className="details-form" onSubmit={saveDetails}>
          <label className="field">
            <span>Title</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={300} />
          </label>
          <label className="field">
            <span>Instructions for faculty</span>
            <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={3} maxLength={10000} />
          </label>
          <div className="row">
            <label className="field field-inline">
              <span>Due date</span>
              <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </label>
            <button type="submit" className="btn" disabled={!changed || busy || !title.trim()}>
              {busy ? 'Saving…' : 'Save details'}
            </button>
          </div>
        </form>
      ) : (
        task.instructions && (
          <div className="instructions">
            <h3>Instructions</h3>
            <p>{task.instructions}</p>
          </div>
        )
      )}
      {msg && (
        <p className={`alert ${msg.kind === 'ok' ? 'alert-ok' : 'alert-error'}`} role={msg.kind === 'error' ? 'alert' : 'status'}>
          {msg.text}
        </p>
      )}
    </div>
  );
}

const AUTOSAVE_MS = 1500;

function isEmptyHtml(html: string) {
  return html.replace(/<[^>]*>/g, '').replace(/[\s ]/g, '') === '' && !/<li/i.test(html);
}

function NarrativeSection({
  detail,
  timezone,
  onTaskChanged,
  reload,
}: {
  detail: TaskDetail;
  timezone: string;
  onTaskChanged: (t: Task) => void;
  reload: () => Promise<void>;
}) {
  const { task, permissions } = detail;
  const editable = permissions.canEdit;
  const labelId = useId();
  const statusId = useId();

  const editorRef = useRef<Editor | null>(null);
  const htmlRef = useRef(detail.response.html);
  const savedRef = useRef(detail.response.html);
  const baseRef = useRef(detail.response.revisionNo);
  const touchedRef = useRef(false);
  const inFlight = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const stateRef = useRef<SaveState>('saved');

  const [state, setStateRaw] = useState<SaveState>('saved');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ResponseRevision | null>(null);
  const [showCompare, setShowCompare] = useState(false);
  const [lastSaved, setLastSaved] = useState<ResponseRevision>(detail.response);
  const [completing, setCompleting] = useState(false);

  const setState = (s: SaveState) => {
    stateRef.current = s;
    setStateRaw(s);
  };

  useEffect(
    () =>
      registerGuard(() => {
        const s = stateRef.current;
        if (s === 'saved') return null;
        if (s === 'saving') return 'Your response is still being saved.';
        if (s === 'conflict') return 'Your response conflicts with a newer version and has not been saved.';
        if (s === 'failed') return 'Your latest changes could not be saved.';
        return 'You have unsaved changes to this response.';
      }),
    [],
  );
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const save = useCallback(async () => {
    window.clearTimeout(timer.current);
    if (inFlight.current || stateRef.current === 'conflict') return;
    const sending = htmlRef.current;
    if (sending === savedRef.current) {
      setError(null);
      setState('saved');
      return;
    }
    inFlight.current = true;
    setState('saving');
    try {
      const r = await api.put<{ task: Task; response: ResponseRevision }>(`/tasks/${task.id}/response`, {
        html: sending,
        baseRevisionNo: baseRef.current,
      });
      savedRef.current = sending;
      baseRef.current = r.response.revisionNo;
      setLastSaved(r.response);
      setError(null);
      onTaskChanged({ ...r.task, wordCount: r.response.wordCount });
      setState(htmlRef.current === sending ? 'saved' : 'dirty');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'revision_conflict') {
        setConflict(e.details.current as ResponseRevision);
        setState('conflict');
      } else if (e instanceof ApiError && (e.code === 'task_complete' || e.code === 'task_archived' || e.code === 'review_archived' || e.status === 403)) {
        setError(`${e.message} Your text has been kept below but was not saved.`);
        setState('failed');
      } else {
        setError(errorMessage(e));
        setState('failed');
      }
    } finally {
      inFlight.current = false;
    }
    // Changes typed during the save are saved next.
    if (stateRef.current === 'dirty') timer.current = window.setTimeout(() => void save(), AUTOSAVE_MS);
  }, [task.id, onTaskChanged]);

  const onChange = (html: string, plain: string) => {
    if (!editorRef.current || isEmptyHtml(html) && isEmptyHtml(savedRef.current) && !touchedRef.current) {
      // Initialization updates from the editor are the baseline, not user edits.
      htmlRef.current = savedRef.current = html;
      setText(plain);
      return;
    }
    touchedRef.current = true;
    htmlRef.current = html;
    setText(plain);
    if (stateRef.current === 'conflict') return;
    if (html === savedRef.current) {
      if (!inFlight.current && stateRef.current !== 'failed') setState('saved');
      return;
    }
    if (stateRef.current !== 'saving' && stateRef.current !== 'failed') setState('dirty');
    window.clearTimeout(timer.current);
    if (stateRef.current !== 'failed') timer.current = window.setTimeout(() => void save(), AUTOSAVE_MS);
  };

  const onReady = useCallback((ed: Editor) => {
    editorRef.current = ed;
    if (!touchedRef.current) {
      // Use the editor's own serialization as the saved baseline to avoid false "unsaved" states.
      htmlRef.current = savedRef.current = ed.getHTML();
      setText(ed.getText());
    }
  }, []);

  const overwrite = () => {
    if (!conflict) return;
    baseRef.current = conflict.revisionNo;
    savedRef.current = conflict.html;
    setConflict(null);
    setShowCompare(false);
    setState('dirty');
    void save();
  };
  const discardMine = () => {
    if (!conflict || !editorRef.current) return;
    if (!window.confirm('Replace your unsaved text with the newer saved version?')) return;
    editorRef.current.commands.setContent(conflict.html || '', { emitUpdate: false });
    htmlRef.current = savedRef.current = editorRef.current.getHTML();
    setText(editorRef.current.getText());
    baseRef.current = conflict.revisionNo;
    setLastSaved(conflict);
    setConflict(null);
    setShowCompare(false);
    setState('saved');
    void reload();
  };

  const complete = async () => {
    setCompleting(true);
    setError(null);
    try {
      const r = await api.post<{ task: Task }>(`/tasks/${task.id}/complete`, { revisionNo: baseRef.current });
      onTaskChanged({ ...r.task, wordCount: lastSaved.wordCount });
      await reload();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'revision_conflict') {
        setConflict(e.details.current as ResponseRevision);
        setState('conflict');
      } else setError(errorMessage(e));
    } finally {
      setCompleting(false);
    }
  };

  const reopen = async () => {
    setError(null);
    try {
      const r = await api.post<{ task: Task }>(`/tasks/${task.id}/reopen`);
      onTaskChanged({ ...r.task, wordCount: lastSaved.wordCount });
      await reload();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const visible = hasVisibleText(text);
  const words = countWords(text);
  const canComplete = permissions.canComplete && state === 'saved' && visible && baseRef.current > 0;
  const completeHint = !permissions.canComplete
    ? null
    : state !== 'saved'
      ? 'Save your latest changes before marking complete.'
      : !visible
        ? 'Write a response with visible text before marking complete.'
        : null;

  const stateLabel: Record<SaveState, string> = {
    saved: lastSaved.revisionNo > 0 ? 'All changes saved' : 'Nothing saved yet',
    dirty: 'Unsaved changes',
    saving: 'Saving…',
    failed: 'Save failed',
    conflict: 'Not saved — conflict',
  };

  return (
    <div
      className="narrative"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          if (editable) void save();
        }
      }}
    >
      <div className="narrative-head">
        <h3 id={labelId}>Narrative response</h3>
        <span className={`save-state save-${state}`} id={statusId} role="status" aria-live="polite">
          {stateLabel[state]}
          {state === 'saved' && lastSaved.createdAt && (
            <span className="muted">
              {' '}
              · revision {lastSaved.revisionNo}, {formatDateTime(lastSaved.createdAt, timezone)}
              {lastSaved.authorName && ` by ${lastSaved.authorName}`}
            </span>
          )}
        </span>
      </div>

      {task.status === 'complete' && (
        <p className="alert alert-ok">
          This response is complete and read-only.
          {permissions.canReopen ? ' Reopen it to make changes.' : ' Ask the review coordinator to reopen it if changes are needed.'}
        </p>
      )}

      {error && (
        <div className="alert alert-error" role="alert">
          {error}
          {state === 'failed' && editable && (
            <>
              {' '}
              Your text is still here.{' '}
              <button type="button" className="btn btn-small" onClick={() => void save()}>
                Retry save
              </button>
            </>
          )}
        </div>
      )}

      {conflict && (
        <div className="alert alert-warn conflict" role="alert">
          <p>
            <strong>Someone else saved a newer version</strong> (revision {conflict.revisionNo}
            {conflict.authorName && ` by ${conflict.authorName}`}
            {conflict.createdAt && `, ${formatDateTime(conflict.createdAt, timezone)}`}). Your text below has <strong>not</strong> been saved.
          </p>
          <div className="row">
            <button type="button" className="btn btn-small" onClick={() => setShowCompare((s) => !s)} aria-expanded={showCompare}>
              {showCompare ? 'Hide newer version' : 'Compare with newer version'}
            </button>
            <button type="button" className="btn btn-small" onClick={overwrite}>
              Save my text as the newest version
            </button>
            <button type="button" className="btn btn-small btn-danger-outline" onClick={discardMine}>
              Discard my text and load theirs
            </button>
          </div>
          {showCompare && (
            <div className="compare">
              <h4>Newer saved version</h4>
              <div className="rich-content compare-box" dangerouslySetInnerHTML={{ __html: conflict.html || '<p><em>(empty)</em></p>' }} />
            </div>
          )}
        </div>
      )}

      <RichEditor initialHtml={detail.response.html} editable={editable} onChange={onChange} labelledBy={labelId} describedBy={statusId} onReady={onReady} />

      <div className="narrative-foot">
        <span className="muted" aria-live="off">
          {words} {words === 1 ? 'word' : 'words'}
        </span>
        <div className="row">
          {editable && (
            <button type="button" className="btn" onClick={() => void save()} disabled={state === 'saving' || state === 'saved' || state === 'conflict'}>
              {state === 'saving' ? 'Saving…' : 'Save'}
            </button>
          )}
          {permissions.canComplete && (
            <button type="button" className="btn btn-primary" onClick={() => void complete()} disabled={!canComplete || completing} aria-describedby={completeHint ? `${statusId}-hint` : undefined}>
              {completing ? 'Marking complete…' : 'Mark complete'}
            </button>
          )}
          {permissions.canReopen && (
            <button type="button" className="btn" onClick={() => void reopen()}>
              Reopen for editing
            </button>
          )}
        </div>
      </div>
      {completeHint && (
        <p className="hint" id={`${statusId}-hint`}>
          {completeHint}
        </p>
      )}

      {permissions.canViewHistory && (
        <History
          taskId={task.id}
          timezone={timezone}
          canRestore={permissions.canManage && permissions.canEdit && state === 'saved'}
          currentRevision={lastSaved.revisionNo}
          onRestored={async () => {
            await reload();
          }}
        />
      )}
    </div>
  );
}

function History({
  taskId,
  timezone,
  canRestore,
  currentRevision,
  onRestored,
}: {
  taskId: number;
  timezone: string;
  canRestore: boolean;
  currentRevision: number;
  onRestored: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [revs, setRevs] = useState<{ revisionNo: number; wordCount: number; createdAt: string; authorName: string; restoredFromRevisionNo: number | null }[] | null>(null);
  const [viewing, setViewing] = useState<ResponseRevision | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    api
      .get<{ revisions: NonNullable<typeof revs> }>(`/tasks/${taskId}/revisions`)
      .then((r) => setRevs(r.revisions))
      .catch((e) => setError(errorMessage(e)));
  }, [open, taskId, currentRevision]);

  const view = async (no: number) => {
    try {
      setViewing((await api.get<{ revision: ResponseRevision }>(`/tasks/${taskId}/revisions/${no}`)).revision);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const restore = async (no: number) => {
    if (!window.confirm(`Restore revision ${no}? It will be saved as a new revision; nothing is deleted.`)) return;
    try {
      await api.post(`/tasks/${taskId}/revisions/${no}/restore`, { baseRevisionNo: currentRevision });
      setViewing(null);
      await onRestored();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <details className="history" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>Revision history</summary>
      <ErrorBanner error={error} />
      {revs && revs.length === 0 && <p className="muted">No saved revisions yet.</p>}
      {revs && revs.length > 0 && (
        <table className="table table-compact">
          <caption className="sr-only">Saved revisions</caption>
          <thead>
            <tr>
              <th scope="col">Rev.</th>
              <th scope="col">Saved</th>
              <th scope="col">Author</th>
              <th scope="col">Words</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {revs.map((r) => (
              <tr key={r.revisionNo}>
                <td>
                  {r.revisionNo}
                  {r.revisionNo === currentRevision && <span className="muted"> (current)</span>}
                  {r.restoredFromRevisionNo && <span className="muted"> ← {r.restoredFromRevisionNo}</span>}
                </td>
                <td>{formatDateTime(r.createdAt, timezone)}</td>
                <td>{r.authorName}</td>
                <td>{r.wordCount}</td>
                <td className="row">
                  <button type="button" className="btn btn-small" onClick={() => void view(r.revisionNo)}>
                    View
                  </button>
                  {canRestore && r.revisionNo !== currentRevision && (
                    <button type="button" className="btn btn-small" onClick={() => void restore(r.revisionNo)}>
                      Restore
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {viewing && (
        <div className="compare">
          <h4>
            Revision {viewing.revisionNo} by {viewing.authorName}
          </h4>
          <div className="rich-content compare-box" dangerouslySetInnerHTML={{ __html: viewing.html || '<p><em>(empty)</em></p>' }} />
        </div>
      )}
    </details>
  );
}
