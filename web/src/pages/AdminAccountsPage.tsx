import { useCallback, useEffect, useState } from 'react';
import type { AccountSummary } from '@shared/types';
import { ApiError, api, errorMessage } from '../api';
import { useAuth } from '../auth';
import { ErrorSummary, Modal, Spinner, StatusMessage } from '../components/ui';

interface TempCredentials {
  username: string;
  temporaryPassword: string;
  expiresAt: string;
  notice?: string;
}

export function AdminAccountsPage(): JSX.Element {
  const { csrfToken, reauthenticate } = useAuth();
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [status, setStatus] = useState<string | null>(null);

  const [username, setUsername] = useState('');
  const [displayLabel, setDisplayLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown>(null);

  const [temp, setTemp] = useState<TempCredentials | null>(null);
  const [copied, setCopied] = useState(false);

  const [resetTarget, setResetTarget] = useState<AccountSummary | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ accounts: AccountSummary[] }>('/admin/accounts');
      setAccounts(data.accounts);
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    document.title = 'Accounts · Seizure Diary';
    void load();
  }, [load]);

  const createAccount = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!csrfToken) return;
    setCreating(true);
    setCreateError(null);
    setStatus(null);
    try {
      const result = await api<{
        account: AccountSummary;
        username: string;
        temporaryPassword: string;
        expiresAt: string;
        notice?: string;
      }>('/admin/accounts', {
        method: 'POST',
        body: {
          username,
          ...(displayLabel.trim() ? { displayLabel: displayLabel.trim() } : {}),
        },
        csrfToken,
      });
      setTemp({
        username: result.username,
        temporaryPassword: result.temporaryPassword,
        expiresAt: result.expiresAt,
        ...(result.notice ? { notice: result.notice } : {}),
      });
      setUsername('');
      setDisplayLabel('');
      await load();
    } catch (caught) {
      setCreateError(caught);
    } finally {
      setCreating(false);
    }
  };

  const submitReset = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!resetTarget || !csrfToken) return;
    setResetBusy(true);
    setResetError(null);
    try {
      await reauthenticate(resetPassword);
      const result = await api<{
        account: AccountSummary;
        username: string;
        temporaryPassword: string;
        expiresAt: string;
        notice?: string;
      }>(`/admin/accounts/${resetTarget.id}/reset-password`, {
        method: 'POST',
        csrfToken,
      });
      setTemp({
        username: result.username,
        temporaryPassword: result.temporaryPassword,
        expiresAt: result.expiresAt,
        ...(result.notice ? { notice: result.notice } : {}),
      });
      setResetTarget(null);
      setResetPassword('');
      await load();
    } catch (caught) {
      setResetError(caught);
    } finally {
      setResetBusy(false);
    }
  };

  const setEnabled = async (account: AccountSummary, enable: boolean) => {
    if (!csrfToken) return;
    const verb = enable ? 'Enable' : 'Disable';
    if (!window.confirm(`${verb} ${account.username}?`)) return;
    setError(null);
    setStatus(null);
    try {
      await api(`/admin/accounts/${account.id}/${enable ? 'enable' : 'disable'}`, {
        method: 'POST',
        csrfToken,
      });
      setStatus(`${verb}d ${account.username}.`);
      await load();
    } catch (caught) {
      setError(caught);
    }
  };

  const copyTemp = async () => {
    if (!temp) return;
    const text = `Seizure Diary\nUsername: ${temp.username}\nTemporary password: ${temp.temporaryPassword}\nExpires: ${new Date(temp.expiresAt).toLocaleString()}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setStatus('Credentials copied. Share them privately, then dismiss this dialog.');
    } catch {
      setStatus('Copy failed. Select the credentials and copy them manually.');
    }
  };

  const fieldErrors =
    createError instanceof ApiError
      ? createError.fields.map((field) => ({ field: field.field, message: field.message }))
      : createError
        ? [{ field: 'form', message: errorMessage(createError) }]
        : [];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Family accounts</h1>
        <p className="muted">
          Create one account per member. There is no public sign-up. You cannot read another
          member’s diary in this app.
        </p>
      </div>

      {status ? <StatusMessage tone="success">{status}</StatusMessage> : null}
      {error ? <StatusMessage tone="error">{errorMessage(error)}</StatusMessage> : null}

      <section className="card space-y-3" aria-labelledby="add-heading">
        <h2 id="add-heading" className="text-lg font-semibold">
          Add account
        </h2>
        <ErrorSummary errors={fieldErrors} />
        <form onSubmit={createAccount} className="space-y-3" noValidate>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="new-username" className="field-label">
                Username
              </label>
              <input
                id="new-username"
                className="field-input"
                value={username}
                autoCapitalize="none"
                spellCheck={false}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="e.g. sample-member"
                aria-describedby="new-username-hint"
              />
              <p id="new-username-hint" className="muted mt-1">
                3–32 characters: lowercase letters, digits, dot, underscore or hyphen.
              </p>
            </div>
            <div>
              <label htmlFor="new-label" className="field-label">
                Display label (optional)
              </label>
              <input
                id="new-label"
                className="field-input"
                value={displayLabel}
                maxLength={80}
                onChange={(event) => setDisplayLabel(event.target.value)}
              />
            </div>
          </div>
          <button type="submit" className="btn-primary" disabled={creating}>
            {creating ? 'Creating…' : 'Create member'}
          </button>
        </form>
      </section>

      <section className="card" aria-labelledby="list-heading">
        <h2 id="list-heading" className="text-lg font-semibold">
          Member accounts
        </h2>
        {loading ? (
          <Spinner label="Loading accounts" />
        ) : accounts.length === 0 ? (
          <p className="muted mt-2">No member accounts yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100">
            {accounts.map((account) => (
              <li key={account.id} className="py-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="font-semibold">{account.displayLabel || account.username}</p>
                    <p className="muted">
                      {account.username} ·{' '}
                      <span className={account.status === 'active' ? 'text-teal-700' : 'text-red-700'}>
                        {account.status}
                      </span>
                      {account.mustChangePassword ? ' · must change password' : ''}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => {
                        setResetTarget(account);
                        setResetPassword('');
                        setResetError(null);
                      }}
                    >
                      Reset password
                    </button>
                    {account.status === 'active' ? (
                      <button
                        type="button"
                        className="btn-danger"
                        onClick={() => void setEnabled(account, false)}
                      >
                        Disable
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => void setEnabled(account, true)}
                      >
                        Enable
                      </button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Modal
        open={temp !== null}
        title="Temporary credentials (shown once)"
        onClose={() => {
          setTemp(null);
          setCopied(false);
        }}
      >
        {temp ? (
          <div className="space-y-3">
            <StatusMessage tone="warning">
              Share these privately now, preferably with a password-manager share or another trusted
              channel. They will not be shown again. Do not email or put them in a URL.
            </StatusMessage>
            <div className="space-y-2">
              <div>
                <p className="field-label">Username</p>
                <input
                  className="field-input"
                  readOnly
                  aria-label="Temporary username"
                  value={temp.username}
                  onFocus={(event) => event.target.select()}
                />
              </div>
              <div>
                <p className="field-label">Temporary password</p>
                <input
                  className="field-input font-mono"
                  readOnly
                  aria-label="Temporary password"
                  value={temp.temporaryPassword}
                  onFocus={(event) => event.target.select()}
                />
              </div>
              <p className="muted">Expires {new Date(temp.expiresAt).toLocaleString()}.</p>
              <p className="muted">
                The member must sign in and set a permanent password before opening the diary.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-secondary" onClick={() => void copyTemp()}>
                {copied ? 'Copied' : 'Copy credentials'}
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  setTemp(null);
                  setCopied(false);
                }}
              >
                Done
              </button>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal open={resetTarget !== null} title="Re-authenticate to reset" onClose={() => setResetTarget(null)}>
        <form onSubmit={submitReset} className="space-y-3">
          <p className="muted">
            Resetting {resetTarget?.username} revokes all their sessions and issues a new temporary
            password. Confirm your own password to continue.
          </p>
          {resetError ? (
            <StatusMessage tone="error">{errorMessage(resetError)}</StatusMessage>
          ) : null}
          <div>
            <label htmlFor="reset-admin-password" className="field-label">
              Your current password
            </label>
            <input
              id="reset-admin-password"
              type="password"
              className="field-input"
              autoComplete="current-password"
              value={resetPassword}
              onChange={(event) => setResetPassword(event.target.value)}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className="btn-primary" disabled={resetBusy}>
              {resetBusy ? 'Resetting…' : 'Reset member password'}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setResetTarget(null)}>
              Cancel
            </button>
          </div>
        </form>
      </Modal>

      <p className="muted text-xs">
        App-level separation does not protect against someone with guest root access, a database
        backup, or an operator impersonating an account after a password reset.
      </p>
    </div>
  );
}
