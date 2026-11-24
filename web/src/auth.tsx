import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AuthUser } from '@shared/types';
import { api, bootstrapLoginCsrf } from './api';

interface SessionResponse {
  authenticated: boolean;
  user: AuthUser;
  restricted: boolean;
  mustChangePassword: boolean;
  csrfToken: string;
  reauthenticatedUntil: string | null;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
}

interface LoginResponse {
  authenticated: boolean;
  user: AuthUser;
  restricted: boolean;
  mustChangePassword: boolean;
  csrfToken: string;
  redirect: string;
}

interface ChangePasswordResponse {
  authenticated: boolean;
  user: AuthUser;
  restricted: boolean;
  mustChangePassword: boolean;
  csrfToken: string;
}

interface AuthContextValue {
  status: 'loading' | 'anon' | 'authed';
  user: AuthUser | null;
  restricted: boolean;
  csrfToken: string | null;
  login: (username: string, password: string) => Promise<LoginResponse>;
  logout: () => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  reauthenticate: (password: string) => Promise<string>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [status, setStatus] = useState<'loading' | 'anon' | 'authed'>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [restricted, setRestricted] = useState(false);
  const [csrfToken, setCsrfToken] = useState<string | null>(null);

  const clear = useCallback(() => {
    setUser(null);
    setRestricted(false);
    setCsrfToken(null);
    setStatus('anon');
  }, []);

  const apply = useCallback(
    (data: {
      user: AuthUser;
      restricted: boolean;
      mustChangePassword: boolean;
      csrfToken: string;
    }) => {
      setUser(data.user);
      setRestricted(data.restricted || data.mustChangePassword);
      setCsrfToken(data.csrfToken);
      setStatus('authed');
    },
    [],
  );

  useEffect(() => {
    let active = true;
    api<SessionResponse>('/auth/session')
      .then((data) => {
        if (!active) return;
        apply(data);
      })
      .catch(() => {
        if (active) clear();
      });
    const onLost = () => clear();
    window.addEventListener('sd:auth-lost', onLost);
    return () => {
      active = false;
      window.removeEventListener('sd:auth-lost', onLost);
    };
  }, [apply, clear]);

  const login = useCallback(
    async (username: string, password: string): Promise<LoginResponse> => {
      const loginCsrf = await bootstrapLoginCsrf();
      const data = await api<LoginResponse>('/auth/login', {
        method: 'POST',
        body: { username, password },
        csrfToken: loginCsrf,
      });
      apply(data);
      return data;
    },
    [apply],
  );

  const logout = useCallback(async (): Promise<void> => {
    const token = csrfToken;
    try {
      if (token) {
        await api<void>('/auth/logout', { method: 'POST', csrfToken: token });
      }
    } catch {
      // Clearing local state is always safe; the server session expires anyway.
    } finally {
      clear();
    }
  }, [clear, csrfToken]);

  const changePassword = useCallback(
    async (currentPassword: string, newPassword: string): Promise<void> => {
      if (!csrfToken) throw new Error('Your session expired. Sign in again.');
      const data = await api<ChangePasswordResponse>('/auth/change-password', {
        method: 'POST',
        body: { currentPassword, newPassword },
        csrfToken,
      });
      apply(data);
    },
    [apply, csrfToken],
  );

  const reauthenticate = useCallback(
    async (password: string): Promise<string> => {
      if (!csrfToken) throw new Error('Your session expired. Sign in again.');
      const data = await api<{ reauthenticatedUntil: string }>('/auth/reauthenticate', {
        method: 'POST',
        body: { password },
        csrfToken,
      });
      return data.reauthenticatedUntil;
    },
    [csrfToken],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      restricted,
      csrfToken,
      login,
      logout,
      changePassword,
      reauthenticate,
    }),
    [status, user, restricted, csrfToken, login, logout, changePassword, reauthenticate],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
