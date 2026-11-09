import { useEffect } from 'react';
import { NavLink, Outlet, useBlocker } from 'react-router-dom';
import { useAuth } from '../auth';
import { confirmLeave, pendingMessage } from '../guard';
import { LoginPage } from '../pages/Login';

export function Layout() {
  const { user, loading, logout } = useAuth();

  // Ask before any in-app navigation while the editor has unsaved or failed work.
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    !!pendingMessage() && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search),
  );
  useEffect(() => {
    if (blocker.state === 'blocked') {
      if (confirmLeave()) blocker.proceed();
      else blocker.reset();
    }
  }, [blocker]);

  if (loading) return <p className="page-loading">Loading…</p>;
  if (!user) return <LoginPage />;

  return (
    <div className="app">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <header className="topbar">
        <NavLink to="/" className="brand">
          <img src="/favicon.svg" alt="" width={24} height={24} /> ProgramAudit
        </NavLink>
        <nav aria-label="Main">
          <NavLink to="/" end>
            Reviews
          </NavLink>
          <NavLink to="/my-tasks">My tasks</NavLink>
          {user.role === 'admin' && <NavLink to="/admin">Administration</NavLink>}
          <NavLink to="/account">Account</NavLink>
        </nav>
        <div className="topbar-user">
          <span>
            {user.displayName} <span className="role-tag">{user.role}</span>
          </span>
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => {
              if (confirmLeave()) void logout();
            }}
          >
            Sign out
          </button>
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
