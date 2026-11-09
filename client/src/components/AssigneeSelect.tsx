import type { FacultyMember, UserNames } from '../types';

/** Professor dropdown. Inactive current assignees stay visible (but not selectable for new assignments). */
export function AssigneeSelect({
  value,
  faculty,
  users,
  onChange,
  labelledBy,
  ariaLabel,
  tabIndex,
  disabled,
}: {
  value: number | null;
  faculty: FacultyMember[];
  users: UserNames;
  onChange: (id: number | null) => void;
  labelledBy?: string;
  ariaLabel?: string;
  tabIndex?: number;
  disabled?: boolean;
}) {
  const assignable = faculty.filter((f) => f.assignable);
  const current = value !== null && !assignable.some((f) => f.id === value) ? value : null;
  const currentName = current !== null ? (users[current]?.displayName ?? faculty.find((f) => f.id === current)?.displayName ?? `User ${current}`) : '';
  return (
    <select
      className="assignee-select"
      value={value ?? ''}
      aria-labelledby={labelledBy}
      aria-label={ariaLabel}
      tabIndex={tabIndex}
      disabled={disabled}
      onKeyDown={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
    >
      <option value="">Unassigned</option>
      {current !== null && (
        <option value={current} disabled>
          {currentName} (inactive)
        </option>
      )}
      {assignable.map((f) => (
        <option key={f.id} value={f.id}>
          {f.displayName}
        </option>
      ))}
    </select>
  );
}
