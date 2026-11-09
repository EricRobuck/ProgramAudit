import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { errorMessage } from '../api';
import type { Status } from '../types';
import { STATUS_LABEL } from '../util';

/** Modal dialog using the native <dialog> element (focus trapping, Escape to close). */
export function Dialog({
  title,
  open,
  onClose,
  children,
  wide,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`dialog${wide ? ' dialog-wide' : ''}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {open && (
        <>
          <div className="dialog-head">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="btn btn-quiet btn-icon" onClick={onClose} aria-label="Close dialog">
              ✕
            </button>
          </div>
          <div className="dialog-body">{children}</div>
        </>
      )}
    </dialog>
  );
}

const STATUS_ICON: Record<Status, string> = { not_started: '○', in_progress: '◐', complete: '●' };

export function StatusBadge({ status, overdue }: { status: Status; overdue?: boolean }) {
  return (
    <span className="badges">
      <span className={`badge badge-${status}`}>
        <span aria-hidden="true">{STATUS_ICON[status]}</span> {STATUS_LABEL[status]}
      </span>
      {overdue && (
        <span className="badge badge-overdue">
          <span aria-hidden="true">!</span> Overdue
        </span>
      )}
    </span>
  );
}

export function ProgressBar({ completed, total, label }: { completed: number; total: number; label: string }) {
  if (total === 0) return <span className="muted">No tasks</span>;
  const pct = Math.round((completed / total) * 100);
  return (
    <span className="progress">
      <span
        className="progress-track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={completed}
        aria-valuetext={`${completed} of ${total} complete`}
      >
        <span className="progress-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="progress-text">
        {completed}/{total} complete ({pct}%)
      </span>
    </span>
  );
}

export function ErrorBanner({ error, onRetry }: { error: string | null; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className="alert alert-error" role="alert">
      {error}{' '}
      {onRetry && (
        <button type="button" className="btn btn-small" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

/** Small disclosure menu of actions (keyboard: Enter/Space opens, arrows move, Escape closes). */
export function ActionMenu({
  label,
  items,
  tabIndex,
}: {
  label: string;
  items: { label: string; onSelect: () => void; disabled?: boolean; danger?: boolean }[];
  tabIndex?: number;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const first = menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
    first?.focus();
    const onDoc = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && e.target !== btn.current) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  const close = () => {
    setOpen(false);
    btn.current?.focus();
  };
  return (
    <span className="menu-wrap">
      <button
        ref={btn}
        type="button"
        className="btn btn-quiet btn-icon"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={label}
        tabIndex={tabIndex}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => e.stopPropagation()}
      >
        ⋯
      </button>
      {open && (
        <div
          ref={menu}
          id={id}
          role="menu"
          className="menu"
          onKeyDown={(e) => {
            e.stopPropagation();
            const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
            const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
            if (e.key === 'Escape') {
              e.preventDefault();
              close();
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              buttons[(i + 1) % buttons.length]?.focus();
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              buttons[(i - 1 + buttons.length) % buttons.length]?.focus();
            } else if (e.key === 'Tab') {
              setOpen(false);
            }
          }}
        >
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className={it.danger ? 'danger' : undefined}
              disabled={it.disabled}
              onClick={() => {
                close();
                it.onSelect();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/** Wraps an async form action with busy and error state. */
export function useFormSubmit<T>(fn: () => Promise<T>, onDone: (r: T) => void | Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onDone(await fn());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit };
}
