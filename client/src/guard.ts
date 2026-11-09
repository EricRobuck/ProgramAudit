/**
 * Registry of "unsaved work" guards. The narrative editor registers one so
 * that navigation (task, review, major or curriculum changes, sign-out, page
 * unload) asks for confirmation while a save is pending or has failed.
 */
type Guard = () => string | null;
const guards = new Set<Guard>();

export function registerGuard(g: Guard): () => void {
  guards.add(g);
  return () => {
    guards.delete(g);
  };
}

export function pendingMessage(): string | null {
  for (const g of guards) {
    const m = g();
    if (m) return m;
  }
  return null;
}

/** Returns true when it is OK to leave (nothing pending, or the user confirmed). */
export function confirmLeave(): boolean {
  const m = pendingMessage();
  return !m || window.confirm(`${m}\n\nLeave anyway? Unsaved changes will be lost.`);
}

window.addEventListener('beforeunload', (e) => {
  if (pendingMessage()) {
    e.preventDefault();
    e.returnValue = '';
  }
});
