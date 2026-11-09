import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { useUser } from '../auth';
import { ErrorBanner, StatusBadge } from '../components/common';
import type { Section, Status } from '../types';
import { SECTIONS } from '../types';
import { formatDate, isOverdue, todayIn } from '../util';

interface MyTask {
  id: number;
  title: string;
  section: Section;
  status: Status;
  dueDate: string | null;
  reviewId: number;
  reviewTitle: string;
  reviewArchived: boolean;
  majorId: number;
  majorName: string;
  curriculumId: number;
  curriculumName: string;
  path: string[];
}

export function MyTasksPage() {
  const user = useUser();
  const [tasks, setTasks] = useState<MyTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hideComplete, setHideComplete] = useState(true);
  const today = todayIn(user.timezone);

  const load = () =>
    api
      .get<{ tasks: MyTask[] }>('/my-tasks')
      .then((r) => setTasks(r.tasks))
      .catch((e) => setError(errorMessage(e)));
  useEffect(() => {
    void load();
  }, []);

  const shown = tasks?.filter((t) => !hideComplete || t.status !== 'complete') ?? [];
  const openCount = tasks?.filter((t) => t.status !== 'complete').length ?? 0;

  return (
    <div className="page">
      <h1>My tasks</h1>
      <ErrorBanner error={error} onRetry={load} />
      {tasks && (
        <>
          <div className="row">
            <p className="muted">
              {openCount} unfinished {openCount === 1 ? 'task' : 'tasks'} assigned to you.
            </p>
            <label className="check">
              <input type="checkbox" checked={hideComplete} onChange={(e) => setHideComplete(e.target.checked)} /> Hide completed
            </label>
          </div>
          {shown.length === 0 ? (
            <p className="empty-state">{tasks.length === 0 ? 'No tasks are assigned to you yet.' : 'Everything assigned to you is complete.'}</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <caption className="sr-only">Tasks assigned to you</caption>
                <thead>
                  <tr>
                    <th scope="col">Task</th>
                    <th scope="col">Review</th>
                    <th scope="col">Section</th>
                    <th scope="col">Due</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((t) => {
                    const overdue = isOverdue(t, today);
                    return (
                      <tr key={t.id}>
                        <td>
                          <Link to={`/?c=${t.curriculumId}&m=${t.majorId}&r=${t.reviewId}&task=${t.id}`}>{t.title}</Link>
                          {t.path.length > 1 && <div className="muted small">{t.path.slice(0, -1).join(' › ')}</div>}
                        </td>
                        <td>
                          {t.reviewTitle}
                          {t.reviewArchived && ' (archived)'}
                          <div className="muted small">
                            {t.curriculumName} › {t.majorName}
                          </div>
                        </td>
                        <td>{SECTIONS.find((s) => s.key === t.section)?.label}</td>
                        <td className={overdue ? 'is-overdue' : undefined}>{t.dueDate ? formatDate(t.dueDate) : '—'}</td>
                        <td>
                          <StatusBadge status={t.status} overdue={overdue} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
