import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { ApiError, errorFieldMap, errorMessage } from '../api';
import { useAuth } from '../auth';
import { BuildFooter, ErrorSummary, StatusMessage } from '../components/ui';

export function LoginPage(): JSX.Element {
  const { status, login, restricted } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = 'Sign in · Seizure Diary';
  }, []);

  if (status === 'loading') {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <p role="status">Loading…</p>
      </main>
    );
  }
  if (status === 'authed') {
    return <Navigate to={restricted ? '/change-password' : '/journal'} replace />;
  }

  const fieldErrors = errorFieldMap(error);
  const summary =
    error && !(error instanceof ApiError && error.fields.length > 0)
      ? [{ field: 'form', message: errorMessage(error) }]
      : error instanceof ApiError
        ? error.fields.map((field) => ({ field: field.field, message: field.message }))
        : [];

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await login(username, password);
      navigate(result.mustChangePassword ? '/change-password' : '/journal', { replace: true });
    } catch (caught) {
      setError(caught);
      passwordRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-slatebg p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold">Seizure Diary</h1>
          <p className="muted mt-1">Private family diary on your own server</p>
        </div>
        <form onSubmit={onSubmit} className="card space-y-4" noValidate>
          <p className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
            A record of what you experienced or observed. This app does not diagnose seizures,
            recommend treatment, or monitor emergencies.
          </p>
          <ErrorSummary errors={summary} />
          <div>
            <label htmlFor="field-username" className="field-label">
              Username
            </label>
            <input
              id="field-username"
              name="username"
              className="field-input"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              aria-invalid={Boolean(fieldErrors.username)}
            />
            {fieldErrors.username ? (
              <p className="mt-1 text-sm text-red-700">{fieldErrors.username}</p>
            ) : null}
          </div>
          <div>
            <label htmlFor="field-password" className="field-label">
              Password
            </label>
            <input
              ref={passwordRef}
              id="field-password"
              name="password"
              type="password"
              className="field-input"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={Boolean(fieldErrors.password)}
            />
            {fieldErrors.password ? (
              <p className="mt-1 text-sm text-red-700">{fieldErrors.password}</p>
            ) : null}
          </div>
          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <p className="muted text-center">
            Need an account? Ask your family administrator. There is no public sign-up.
          </p>
          <StatusMessage tone="info">
            Saved to your family’s private server. Your browser needs a connection to this server
            (home network or WireGuard) to sign in and save entries.
          </StatusMessage>
        </form>
        <p className="muted mt-4 text-center">
          <Link to="/login" className="link" onClick={(event) => event.preventDefault()}>
            Private server-backed app — not offline-first
          </Link>
        </p>
      </div>
      <BuildFooter className="fixed bottom-3 right-4" />
    </main>
  );
}
