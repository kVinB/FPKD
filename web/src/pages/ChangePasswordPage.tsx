import { useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ApiError, errorFieldMap, errorMessage } from '../api';
import { useAuth } from '../auth';
import { ErrorSummary, StatusMessage } from '../components/ui';
import { deviceTimeZone } from '../components/ui';
import { fetchSettings, saveReportZone } from '../settingsClient';

export function ChangePasswordPage(): JSX.Element {
  const { status, restricted, changePassword, logout, csrfToken } = useAuth();
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = 'Change password · Seizure Diary';
  }, []);

  if (status === 'loading') {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <p role="status">Loading…</p>
      </main>
    );
  }
  if (status === 'anon') return <Navigate to="/login" replace />;

  const fieldErrors = errorFieldMap(error);
  const summary: { field: string; message: string }[] = [];
  if (localError) summary.push({ field: 'form', message: localError });
  if (error instanceof ApiError) {
    for (const field of error.fields) summary.push({ field: field.field, message: field.message });
    if (error.fields.length === 0) summary.push({ field: 'form', message: error.message });
  } else if (error) {
    summary.push({ field: 'form', message: errorMessage(error) });
  }

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLocalError(null);
    setError(null);
    if (newPassword !== confirm) {
      setLocalError('The new passwords do not match.');
      return;
    }
    if (newPassword.length < 15) {
      setLocalError('Use at least 15 characters.');
      return;
    }
    setBusy(true);
    try {
      await changePassword(currentPassword, newPassword);
      try {
        const settings = await fetchSettings();
        const zone = deviceTimeZone();
        if (settings.reportZone === 'UTC' && zone !== 'UTC' && csrfToken) {
          await saveReportZone(zone, csrfToken);
        }
      } catch {
        // The password change succeeded; report-zone setup can be retried in Settings.
      }
      navigate('/journal', { replace: true });
    } catch (caught) {
      setError(caught);
      firstRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md">
        <h1 className="mb-2 text-2xl font-bold">
          {restricted ? 'Set your permanent password' : 'Change password'}
        </h1>
        <p className="muted mb-4">
          {restricted
            ? 'Your temporary password opened only this page. Choose a permanent password to use your diary.'
            : 'Choose a new password for your account.'}
        </p>
        <form onSubmit={onSubmit} className="card space-y-4" noValidate>
          {restricted ? (
            <StatusMessage tone="info">
              This is a restricted first-login session. It can only set a password or sign out.
            </StatusMessage>
          ) : null}
          <ErrorSummary errors={summary} />
          <div>
            <label htmlFor="field-currentPassword" className="field-label">
              Current password
            </label>
            <input
              ref={firstRef}
              id="field-currentPassword"
              type="password"
              className="field-input"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              aria-invalid={Boolean(fieldErrors.currentPassword)}
            />
            {fieldErrors.currentPassword ? (
              <p className="mt-1 text-sm text-red-700">{fieldErrors.currentPassword}</p>
            ) : null}
          </div>
          <div>
            <label htmlFor="field-newPassword" className="field-label">
              New password
            </label>
            <input
              id="field-newPassword"
              type="password"
              className="field-input"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              aria-describedby="new-password-hint"
              aria-invalid={Boolean(fieldErrors.newPassword)}
            />
            <p id="new-password-hint" className="muted mt-1">
              15–128 characters. Paste and password managers are allowed.
            </p>
            {fieldErrors.newPassword ? (
              <p className="mt-1 text-sm text-red-700">{fieldErrors.newPassword}</p>
            ) : null}
          </div>
          <div>
            <label htmlFor="field-confirmPassword" className="field-label">
              Confirm new password
            </label>
            <input
              id="field-confirmPassword"
              type="password"
              className="field-input"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <button type="submit" className="btn-primary flex-1" disabled={busy}>
              {busy ? 'Saving…' : 'Save new password'}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                void logout();
              }}
            >
              Sign out
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}
