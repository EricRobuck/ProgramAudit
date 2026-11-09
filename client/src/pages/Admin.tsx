import { useEffect, useState, type FormEvent } from 'react';
import { api, errorMessage } from '../api';
import { useUser } from '../auth';
import { ErrorBanner } from '../components/common';
import type { Curriculum, Major, Role, User } from '../types';

export function AdminPage() {
  const user = useUser();
  const [tab, setTab] = useState<'users' | 'catalog'>('users');
  if (user.role !== 'admin') return <p className="page">Administrator access is required.</p>;
  return (
    <div className="page">
      <h1>Administration</h1>
      <div role="tablist" aria-label="Administration" className="section-tabs section-tabs-always">
        {(['users', 'catalog'] as const).map((t) => (
          <button key={t} type="button" role="tab" id={`admin-tab-${t}`} aria-selected={tab === t} aria-controls={`admin-panel-${t}`} onClick={() => setTab(t)}>
            {t === 'users' ? 'Accounts & faculty roster' : 'Curricula & majors'}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`admin-panel-${tab}`} aria-labelledby={`admin-tab-${tab}`}>
        {tab === 'users' ? <Users /> : <CatalogAdmin />}
      </div>
    </div>
  );
}

function Users() {
  const me = useUser();
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({ email: '', displayName: '', role: 'professor' as Role, isFaculty: true, password: '' });

  const load = () =>
    api
      .get<{ users: User[] }>('/users')
      .then((r) => setUsers(r.users))
      .catch((e) => setError(errorMessage(e)));
  useEffect(() => {
    void load();
  }, []);

  const act = async (fn: () => Promise<unknown>, msg: string) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(msg);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const create = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      await api.post('/users', form);
      setForm({ email: '', displayName: '', role: 'professor', isFaculty: true, password: '' });
    }, 'Account created.');
  };

  return (
    <div className="stack">
      <ErrorBanner error={error} />
      {notice && (
        <p className="alert alert-ok" role="status">
          {notice}
        </p>
      )}
      {users && (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">Accounts</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col">Faculty (assignable)</th>
                <th scope="col">Active</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className={u.active ? undefined : 'is-inactive'}>
                  <td>
                    {u.displayName}
                    {u.id === me.id && ' (you)'}
                  </td>
                  <td>{u.email}</td>
                  <td>
                    <select
                      aria-label={`Role for ${u.displayName}`}
                      value={u.role}
                      onChange={(e) => void act(() => api.patch(`/users/${u.id}`, { role: e.target.value }), `Role updated for ${u.displayName}.`)}
                    >
                      <option value="admin">Administrator</option>
                      <option value="coordinator">Coordinator</option>
                      <option value="professor">Professor</option>
                    </select>
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`${u.displayName} can be assigned tasks`}
                      checked={u.isFaculty}
                      onChange={(e) => void act(() => api.patch(`/users/${u.id}`, { isFaculty: e.target.checked }), 'Updated.')}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`${u.displayName} account active`}
                      checked={u.active}
                      onChange={(e) => {
                        if (!e.target.checked && !window.confirm(`Deactivate ${u.displayName}? They will be signed out and cannot receive new assignments. Their past work stays attributed to them.`)) return;
                        void act(() => api.patch(`/users/${u.id}`, { active: e.target.checked }), 'Updated.');
                      }}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() => {
                        const pw = window.prompt(`New password for ${u.displayName} (at least 10 characters):`);
                        if (pw) void act(() => api.patch(`/users/${u.id}`, { password: pw }), `Password reset for ${u.displayName}.`);
                      }}
                    >
                      Reset password<span className="sr-only"> for {u.displayName}</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form className="card stack" onSubmit={create}>
        <h2>Add account</h2>
        <div className="form-grid">
          <label className="field">
            <span>Display name</span>
            <input required value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
          </label>
          <label className="field">
            <span>Email</span>
            <input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </label>
          <label className="field">
            <span>Role</span>
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
              <option value="professor">Professor</option>
              <option value="coordinator">Coordinator</option>
              <option value="admin">Administrator</option>
            </select>
          </label>
          <label className="field">
            <span>Initial password (10+ characters)</span>
            <input required type="password" minLength={10} autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={form.isFaculty} onChange={(e) => setForm({ ...form, isFaculty: e.target.checked })} /> Faculty member (can be assigned tasks)
        </label>
        <div>
          <button type="submit" className="btn btn-primary">
            Create account
          </button>
        </div>
      </form>
    </div>
  );
}

function CatalogAdmin() {
  const [data, setData] = useState<{ curricula: Curriculum[]; majors: Major[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newCurriculum, setNewCurriculum] = useState('');
  const [newMajor, setNewMajor] = useState<Record<number, string>>({});
  const [showArchived, setShowArchived] = useState(false);

  const load = () =>
    api
      .get<{ curricula: Curriculum[]; majors: Major[] }>('/catalog?includeArchived=1')
      .then(setData)
      .catch((e) => setError(errorMessage(e)));
  useEffect(() => {
    void load();
  }, []);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const rename = (kind: 'curricula' | 'majors', id: number, current: string) => {
    const name = window.prompt('New name:', current);
    if (name && name.trim() && name !== current) void act(() => api.patch(`/${kind}/${id}`, { name }));
  };

  return (
    <div className="stack">
      <ErrorBanner error={error} />
      <label className="check">
        <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived
      </label>
      {data?.curricula
        .filter((c) => showArchived || !c.archived)
        .map((c) => (
          <section key={c.id} className={`card${c.archived ? ' is-inactive' : ''}`} aria-labelledby={`cur-${c.id}`}>
            <div className="row">
              <h2 id={`cur-${c.id}`}>
                {c.name}
                {c.archived && <span className="badge badge-archived">Archived</span>}
              </h2>
              <span className="spacer" />
              <button type="button" className="btn btn-small" onClick={() => rename('curricula', c.id, c.name)}>
                Rename<span className="sr-only"> {c.name}</span>
              </button>
              <button type="button" className="btn btn-small" onClick={() => void act(() => api.patch(`/curricula/${c.id}`, { archived: !c.archived }))}>
                {c.archived ? 'Restore' : 'Archive'}
                <span className="sr-only"> {c.name}</span>
              </button>
            </div>
            <ul className="plain-list">
              {data.majors
                .filter((m) => m.curriculumId === c.id && (showArchived || !m.archived))
                .map((m) => (
                  <li key={m.id} className="row">
                    <span>
                      {m.name}
                      {m.archived && <span className="badge badge-archived">Archived</span>}
                    </span>
                    <span className="spacer" />
                    <button type="button" className="btn btn-small" onClick={() => rename('majors', m.id, m.name)}>
                      Rename<span className="sr-only"> {m.name}</span>
                    </button>
                    <button type="button" className="btn btn-small" onClick={() => void act(() => api.patch(`/majors/${m.id}`, { archived: !m.archived }))}>
                      {m.archived ? 'Restore' : 'Archive'}
                      <span className="sr-only"> {m.name}</span>
                    </button>
                  </li>
                ))}
            </ul>
            {!c.archived && (
              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  const name = newMajor[c.id]?.trim();
                  if (name) void act(() => api.post('/majors', { curriculumId: c.id, name })).then(() => setNewMajor({ ...newMajor, [c.id]: '' }));
                }}
              >
                <label className="field field-inline">
                  <span>New major</span>
                  <input value={newMajor[c.id] ?? ''} onChange={(e) => setNewMajor({ ...newMajor, [c.id]: e.target.value })} />
                </label>
                <button type="submit" className="btn btn-small">
                  Add major
                </button>
              </form>
            )}
          </section>
        ))}
      <form
        className="card row"
        onSubmit={(e) => {
          e.preventDefault();
          if (newCurriculum.trim()) void act(() => api.post('/curricula', { name: newCurriculum })).then(() => setNewCurriculum(''));
        }}
      >
        <label className="field field-inline">
          <span>New curriculum</span>
          <input value={newCurriculum} onChange={(e) => setNewCurriculum(e.target.value)} />
        </label>
        <button type="submit" className="btn btn-primary">
          Add curriculum
        </button>
      </form>
    </div>
  );
}
