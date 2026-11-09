import { useMemo, useState, type FormEvent } from 'react';
import { api, errorMessage } from '../api';
import { useAuth, useUser } from '../auth';
import type { User } from '../types';

export function AccountPage() {
  const user = useUser();
  const { setUser } = useAuth();
  const [displayName, setDisplayName] = useState(user.displayName);
  const [timezone, setTimezone] = useState(user.timezone);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const zones = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf('timeZone');
    } catch {
      return [user.timezone];
    }
  }, [user.timezone]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    try {
      const body: Record<string, string> = { displayName, timezone };
      if (newPassword) Object.assign(body, { currentPassword, newPassword });
      const r = await api.patch<{ user: User }>('/auth/me', body);
      setUser(r.user);
      setCurrentPassword('');
      setNewPassword('');
      setMsg({ ok: true, text: 'Saved.' });
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err) });
    }
  };

  return (
    <div className="page narrow">
      <h1>Account</h1>
      <form className="card stack" onSubmit={save}>
        {msg && (
          <p className={`alert ${msg.ok ? 'alert-ok' : 'alert-error'}`} role={msg.ok ? 'status' : 'alert'}>
            {msg.text}
          </p>
        )}
        <p className="muted">
          {user.email} · {user.role}
        </p>
        <label className="field">
          <span>Display name</span>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required maxLength={120} />
        </label>
        <label className="field">
          <span>Timezone (used for all times shown to you)</span>
          <select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="field">
          <legend>Change password (optional)</legend>
          <label className="field">
            <span>Current password</span>
            <input type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
          </label>
          <label className="field">
            <span>New password (10+ characters)</span>
            <input type="password" autoComplete="new-password" minLength={10} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
          </label>
        </fieldset>
        <div>
          <button type="submit" className="btn btn-primary">
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
