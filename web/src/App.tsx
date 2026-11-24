import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { JournalPage } from './pages/JournalPage';
import { EventFormPage } from './pages/EventFormPage';
import { EventDetailPage } from './pages/EventDetailPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { ReportsPage } from './pages/ReportsPage';
import { SettingsPage } from './pages/SettingsPage';
import { AdminAccountsPage } from './pages/AdminAccountsPage';
import { MorePage, NotFoundPage } from './pages/MorePage';

function LoadingScreen(): JSX.Element {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <p role="status">Loading Seizure Diary…</p>
    </main>
  );
}

function ProtectedShell(): JSX.Element {
  const { status, restricted } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <LoadingScreen />;
  if (status === 'anon') return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (restricted && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />;
  }
  return (
    <Layout>
      <Outlet />
    </Layout>
  );
}

function AdminGuard(): JSX.Element {
  const { user } = useAuth();
  if (user?.role !== 'admin') return <Navigate to="/journal" replace />;
  return <Outlet />;
}

function RootRedirect(): JSX.Element {
  const { status, restricted } = useAuth();
  if (status === 'loading') return <LoadingScreen />;
  if (status === 'anon') return <Navigate to="/login" replace />;
  return <Navigate to={restricted ? '/change-password' : '/journal'} replace />;
}

export function App(): JSX.Element {
  return (
    <Routes>
      <Route path="/" element={<RootRedirect />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/change-password" element={<ChangePasswordPage />} />

      <Route element={<ProtectedShell />}>
        <Route path="/journal" element={<JournalPage />} />
        <Route path="/events/new" element={<EventFormPage mode="new" />} />
        <Route path="/events/:id" element={<EventDetailPage />} />
        <Route path="/events/:id/edit" element={<EventFormPage mode="edit" />} />
        <Route path="/analytics" element={<AnalyticsPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/more" element={<MorePage />} />
        <Route element={<AdminGuard />}>
          <Route path="/admin/accounts" element={<AdminAccountsPage />} />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
