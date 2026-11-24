import { Link } from 'react-router-dom';
import { useAuth } from '../auth';
import { StatusMessage } from '../components/ui';

export function MorePage(): JSX.Element {
  const { user, logout } = useAuth();
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">More</h1>
      <nav aria-label="More navigation" className="card space-y-2">
        <Link to="/settings" className="btn-secondary w-full justify-start">
          Settings and backups
        </Link>
        {user?.role === 'admin' ? (
          <Link to="/admin/accounts" className="btn-secondary w-full justify-start">
            Family accounts (admin)
          </Link>
        ) : null}
        <Link to="/change-password" className="btn-secondary w-full justify-start">
          Change password
        </Link>
        <button type="button" className="btn-secondary w-full justify-start" onClick={() => void logout()}>
          Sign out
        </button>
      </nav>
      <StatusMessage tone="info">
        Saved to your family’s private server. Your browser needs a connection to this server (home
        network or WireGuard) to save or retrieve diary data. Downloaded PDFs and JSON backups leave
        the app’s storage.
      </StatusMessage>
      <p className="muted text-xs">
        The app does not diagnose seizures, recommend treatment, or monitor emergencies. Charts and
        reports say logged events, not verified seizure counts.
      </p>
    </div>
  );
}

export function NotFoundPage(): JSX.Element {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Page not found</h1>
      <p className="muted">The page you requested does not exist.</p>
      <Link to="/journal" className="btn-primary">
        Go to journal
      </Link>
    </div>
  );
}
