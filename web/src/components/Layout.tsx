import { Link, NavLink, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '../auth';
import { BuildFooter } from './ui';

const navItems = [
  { to: '/journal', label: 'Journal' },
  { to: '/analytics', label: 'Analytics' },
  { to: '/reports', label: 'Reports' },
  { to: '/settings', label: 'Settings' },
];

function NavItem({ to, label, onNavigate }: { to: string; label: string; onNavigate?: () => void }): JSX.Element {
  return (
    <NavLink
      to={to}
      onClick={onNavigate}
      className={({ isActive }) =>
        `flex min-h-[44px] items-center rounded-lg px-3 py-2 text-sm font-semibold ${
          isActive ? 'bg-teal-50 text-teal-700' : 'text-slate-700 hover:bg-slate-100'
        }`
      }
    >
      {label}
    </NavLink>
  );
}

export function Layout({ children }: { children: ReactNode }): JSX.Element {
  const { user, logout } = useAuth();
  const location = useLocation();
  const editing = location.pathname === '/events/new' || location.pathname.endsWith('/edit');

  return (
    <div className="flex min-h-screen flex-col bg-slatebg">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <Link to="/journal" className="text-lg font-bold text-ink no-underline">
            Seizure Diary
          </Link>
          <div className="flex items-center gap-2">
            <span className="hidden text-sm text-slate-600 sm:inline">
              {user?.displayLabel || user?.username}
              {user?.role === 'admin' ? ' · admin' : ''}
            </span>
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
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-6xl flex-1 gap-6 px-4 py-4">
        <aside className="hidden w-48 shrink-0 md:block">
          <nav aria-label="Main navigation" className="sticky top-20 space-y-1">
            {navItems.map((item) => (
              <NavItem key={item.to} {...item} />
            ))}
            {user?.role === 'admin' ? <NavItem to="/admin/accounts" label="Accounts" /> : null}
            <p className="mt-4 px-3 text-xs text-slate-600">
              Saved to your family’s private server.
            </p>
          </nav>
        </aside>

        <main id="main-content" className="min-w-0 flex-1 pb-4">
          {children}
        </main>
      </div>

      <BuildFooter
        className={`mx-auto w-full max-w-6xl px-4 ${editing ? 'pb-4 md:pb-6' : 'pb-24 md:pb-6'}`}
      />

      {!editing ? (
        <nav
          aria-label="Mobile navigation"
          className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] md:hidden"
        >
          <div className="grid grid-cols-4">
            <NavItem to="/journal" label="Journal" />
            <NavItem to="/analytics" label="Charts" />
            <NavItem to="/reports" label="Reports" />
            <NavItem to="/more" label="More" />
          </div>
        </nav>
      ) : null}
    </div>
  );
}
