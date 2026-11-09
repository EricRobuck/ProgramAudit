import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth';
import { errorMessage } from '../api';

export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login-page" id="main">
      <form className="login-card" onSubmit={submit} aria-labelledby="login-title">
        <img src="/favicon.svg" alt="" width={40} height={40} />
        <h1 id="login-title">ProgramAudit</h1>
        <p className="muted">Curriculum audit and program review</p>
        {error && (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        )}
        <label className="field">
          <span>Email</span>
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </label>
        <label className="field">
          <span>Password</span>
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
