import { Fragment, useCallback, useEffect, useState, type ReactElement } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, errorMessage } from '../api';
import { useUser } from '../auth';
import { ErrorBanner } from '../components/common';
import type { Block, Curriculum, Major, ReportContent, Review, Run, SnapshotSummary } from '../types';
import { formatDateTime, STATUS_LABEL } from '../util';

interface ReviewInfo {
  review: Review;
  major: Pick<Major, 'id' | 'name'>;
  curriculum: Pick<Curriculum, 'id' | 'name'>;
}

export function ReportPage() {
  const user = useUser();
  const reviewId = Number(useParams().reviewId);
  const [info, setInfo] = useState<ReviewInfo | null>(null);
  const [mode, setMode] = useState<'working' | 'completed'>('working');
  const [attribution, setAttribution] = useState(false);
  const [preview, setPreview] = useState<ReportContent | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [viewing, setViewing] = useState<{ id: number; content: ReportContent } | null>(null);
  const [created, setCreated] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canManage = info?.review.myAccess === 'admin' || info?.review.myAccess === 'coordinator';

  const loadSnapshots = useCallback(
    () =>
      api
        .get<{ snapshots: SnapshotSummary[] }>(`/reviews/${reviewId}/reports`)
        .then((r) => setSnapshots(r.snapshots))
        .catch((e) => setError(errorMessage(e))),
    [reviewId],
  );

  useEffect(() => {
    api
      .get<ReviewInfo>(`/reviews/${reviewId}`)
      .then(setInfo)
      .catch((e) => setError(errorMessage(e)));
    void loadSnapshots();
  }, [reviewId, loadSnapshots]);

  useEffect(() => {
    setPreview(null);
    api
      .get<{ content: ReportContent }>(`/reviews/${reviewId}/report-preview?mode=${mode}&attribution=${attribution ? 1 : 0}`)
      .then((r) => setPreview(r.content))
      .catch((e) => setError(errorMessage(e)));
  }, [reviewId, mode, attribution]);

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ snapshot: SnapshotSummary & { content: ReportContent } }>(`/reviews/${reviewId}/reports`, { mode, attribution });
      setCreated(r.snapshot.id);
      setViewing({ id: r.snapshot.id, content: r.snapshot.content });
      await loadSnapshots();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const view = async (id: number) => {
    try {
      const r = await api.get<{ snapshot: { content: ReportContent } }>(`/reports/${id}`);
      setViewing({ id, content: r.snapshot.content });
      document.getElementById('report-view')?.scrollIntoView({ behavior: 'smooth' });
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const shown = viewing?.content ?? preview;

  return (
    <div className="page report-page">
      <p>
        <Link to={info ? `/?c=${info.curriculum.id}&m=${info.major.id}&r=${reviewId}` : '/'}>← Back to review</Link>
      </p>
      <h1>Report{info && `: ${info.review.title}`}</h1>
      <ErrorBanner error={error} />

      <div className="report-layout">
        <aside className="report-controls" aria-label="Report options">
          <fieldset className="field">
            <legend>Report type</legend>
            <label className="check">
              <input type="radio" name="mode" checked={mode === 'working'} onChange={() => { setMode('working'); setViewing(null); }} />
              <span>
                <strong>Working report</strong>
                <br />
                <span className="muted small">Every active task, with draft and missing labels, faculty and status.</span>
              </span>
            </label>
            <label className="check">
              <input type="radio" name="mode" checked={mode === 'completed'} onChange={() => { setMode('completed'); setViewing(null); }} />
              <span>
                <strong>Completed responses</strong>
                <br />
                <span className="muted small">Only completed narratives, with parent headings for context.</span>
              </span>
            </label>
          </fieldset>
          {mode === 'completed' && (
            <label className="check">
              <input type="checkbox" checked={attribution} onChange={(e) => { setAttribution(e.target.checked); setViewing(null); }} /> Show contributor names
            </label>
          )}

          {preview && (
            <div className="report-summary" aria-live="polite">
              <h2>Before you export</h2>
              <ul>
                <li>
                  Progress: <strong>{preview.progress.total === 0 ? 'No tasks' : `${preview.progress.completed} of ${preview.progress.total} complete`}</strong>
                </li>
                <li>
                  Unfinished tasks: <strong>{preview.counts.unfinishedTasks}</strong>
                </li>
                {mode === 'completed' && (
                  <li>
                    Excluded from this report: <strong>{preview.counts.excludedTasks}</strong>
                  </li>
                )}
                <li>
                  Completed narratives included: <strong>{preview.counts.includedNarratives}</strong>
                </li>
              </ul>
              {!preview.allComplete && preview.progress.total > 0 && (
                <p className="alert alert-warn">This review is not complete. Exported reports will be labeled as incomplete.</p>
              )}
            </div>
          )}

          {canManage ? (
            <>
              <button type="button" className="btn btn-primary btn-block" onClick={() => void generate()} disabled={busy || !preview}>
                {busy ? 'Generating…' : 'Generate report snapshot'}
              </button>
              <p className="hint">A snapshot freezes the currently saved responses. Later edits never change it.</p>
            </>
          ) : (
            <p className="hint">Only review coordinators can generate snapshots. You can preview the report and download existing snapshots.</p>
          )}
          {created && (
            <div className="alert alert-ok" role="status">
              Snapshot #{created} created.{' '}
              <a href={`/api/reports/${created}/download?format=docx`}>Download DOCX</a> · <a href={`/api/reports/${created}/download?format=pdf`}>Download PDF</a>
            </div>
          )}

          <h2>Snapshots</h2>
          {snapshots.length === 0 ? (
            <p className="muted">No snapshots yet.</p>
          ) : (
            <ul className="snapshot-list">
              {snapshots.map((s) => (
                <li key={s.id} className={viewing?.id === s.id ? 'is-current' : undefined}>
                  <div>
                    <strong>#{s.id}</strong> {s.mode === 'working' ? 'Working' : 'Completed responses'} · {s.completedTaskCount}/{s.activeTaskCount} complete
                  </div>
                  <div className="muted small">
                    {formatDateTime(s.createdAt, user.timezone)} by {s.createdBy}
                  </div>
                  <div className="row">
                    <button type="button" className="btn btn-small" onClick={() => void view(s.id)}>
                      View<span className="sr-only"> snapshot {s.id}</span>
                    </button>
                    <a className="btn btn-small" href={`/api/reports/${s.id}/download?format=docx`}>
                      DOCX<span className="sr-only"> for snapshot {s.id}</span>
                    </a>
                    <a className="btn btn-small" href={`/api/reports/${s.id}/download?format=pdf`}>
                      PDF<span className="sr-only"> for snapshot {s.id}</span>
                    </a>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className="report-view" id="report-view" aria-label={viewing ? `Snapshot ${viewing.id}` : 'Live preview'}>
          <div className={`report-banner ${viewing ? 'is-snapshot' : 'is-preview'}`}>
            {viewing ? (
              <>
                Viewing saved snapshot #{viewing.id}.{' '}
                <button type="button" className="btn btn-small" onClick={() => setViewing(null)}>
                  Back to live preview
                </button>
              </>
            ) : (
              'Live preview of currently saved responses (not stored).'
            )}
          </div>
          {shown ? <ReportDocument c={shown} /> : <p className="page-loading">Building preview…</p>}
        </section>
      </div>
    </div>
  );
}

function runs(rs: Run[]) {
  return rs.map((r, i) => {
    if (r.br) return <br key={i} />;
    let el = <Fragment key={i}>{r.text}</Fragment>;
    if (r.italic) el = <em key={i}>{el}</em>;
    if (r.bold) el = <strong key={i}>{el}</strong>;
    return el;
  });
}

/** Renders flat narrative blocks back into nested lists for display. */
function Narrative({ blocks }: { blocks: Block[] }) {
  const out: ReactElement[] = [];
  let i = 0;
  const list = (level: number): ReactElement => {
    const ordered = (blocks[i] as Extract<Block, { type: 'li' }>).ordered;
    const items: ReactElement[] = [];
    while (i < blocks.length) {
      const b = blocks[i];
      if (b.type !== 'li' || b.level < level) break;
      if (b.level > level) {
        const nested = list(b.level);
        items.push(<li key={`n${i}`} className="nested">{nested}</li>);
        continue;
      }
      items.push(<li key={i}>{runs(b.runs)}</li>);
      i++;
    }
    return ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
  };
  while (i < blocks.length) {
    const b = blocks[i];
    if (b.type === 'p') {
      out.push(<p key={i}>{runs(b.runs)}</p>);
      i++;
    } else out.push(<Fragment key={`l${i}`}>{list(b.level)}</Fragment>);
  }
  return <div className="rich-content">{out}</div>;
}

function ReportDocument({ c }: { c: ReportContent }) {
  const H = (depth: number) => (['h3', 'h4', 'h5', 'h6'][Math.min(depth - 1, 3)] as 'h3');
  const status = c.progress.total === 0
    ? 'No tasks have been defined for this review.'
    : c.allComplete
      ? `All ${c.progress.total} active tasks are marked complete.`
      : `Incomplete: ${c.progress.completed} of ${c.progress.total} active tasks are complete; ${c.progress.total - c.progress.completed} unfinished.`;
  return (
    <article className="report-doc">
      <header>
        <h2 className="report-title">{c.title}</h2>
        <p className="report-sub">
          {c.curriculum} — {c.major}
        </p>
        <dl className="meta-grid">
          <div>
            <dt>Review period</dt>
            <dd>{c.period || '—'}</dd>
          </div>
          <div>
            <dt>Report type</dt>
            <dd>{c.mode === 'working' ? 'Working report' : 'Completed-response report'}</dd>
          </div>
          <div>
            <dt>Generated</dt>
            <dd>
              {c.generatedAtLabel} by {c.generatedBy}
            </dd>
          </div>
        </dl>
        <p className={c.allComplete ? 'alert alert-ok' : 'alert alert-warn'}>{status}</p>
        {c.unresolved.length > 0 && (
          <details>
            <summary>Unresolved work ({c.unresolved.length})</summary>
            <ul>
              {c.unresolved.map((u) => (
                <li key={u.taskId}>
                  {u.section[0].toUpperCase() + u.section.slice(1)} › {u.path.join(' › ')} — <em>{STATUS_LABEL[u.status]}, {u.assignee ?? 'Unassigned'}</em>
                </li>
              ))}
            </ul>
          </details>
        )}
      </header>
      {c.sections.map((s) => (
        <section key={s.key} className="report-section">
          <h2>{s.label}</h2>
          {s.nodes.length === 0 && <p className="muted">No content.</p>}
          {s.nodes.map((n) => {
            const Tag = H(n.depth);
            return (
              <div key={n.taskId} className="report-node" style={{ marginLeft: `${Math.min(n.depth - 1, 6) * 12}px` }}>
                <Tag>
                  <span className="outline">{n.outline}</span> {n.title}
                </Tag>
                {c.mode === 'working' && (
                  <p className="report-meta">
                    Assigned: {n.assignee ?? 'Unassigned'} · Status: {STATUS_LABEL[n.status]}
                  </p>
                )}
                {c.mode === 'completed' && c.options.attribution && n.kind === 'narrative' && <p className="report-meta">Contributor: {n.assignee ?? 'Unassigned'}</p>}
                {n.kind === 'draft' && <p className="report-flag">DRAFT — not yet marked complete</p>}
                {n.kind === 'missing' && <p className="report-flag is-missing">No response yet.</p>}
                {(n.kind === 'narrative' || n.kind === 'draft') && <Narrative blocks={n.blocks} />}
              </div>
            );
          })}
        </section>
      ))}
    </article>
  );
}
