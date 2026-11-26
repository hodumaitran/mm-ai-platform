'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, apiJson, onUnauthorized, setCsrfToken } from '../lib/api.ts';
import { ChatApp } from './chat-app.tsx';
import { LoginForm, type SessionUser } from './login-form.tsx';

type AuthState =
  | { status: 'loading' }
  | { status: 'anonymous'; notice: string | null }
  | { status: 'authenticated'; user: SessionUser };

const EXPIRED_NOTICE = 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.';

export function AppShell() {
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' });
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => {
    // Any 401 from the API (expired, revoked or deactivated) returns the user to the login page.
    onUnauthorized(() => setAuth({ status: 'anonymous', notice: EXPIRED_NOTICE }));
    let cancelled = false;
    apiJson<{ user: SessionUser; csrfToken: string }>('GET', '/auth/me', { sessionOptional: true })
      .then((result) => {
        if (cancelled) return;
        setCsrfToken(result.csrfToken);
        setAuth({ status: 'authenticated', user: result.user });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401) {
          setAuth({ status: 'anonymous', notice: null });
        } else {
          setUnreachable(true);
          setAuth({ status: 'anonymous', notice: null });
        }
      });
    return () => {
      cancelled = true;
      onUnauthorized(null);
    };
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    try {
      await apiJson('POST', '/auth/logout', { sessionOptional: true });
    } catch {
      // The server-side session may already be gone; the browser state is cleared either way.
    }
    setCsrfToken('');
    setAuth({ status: 'anonymous', notice: null });
  }, []);

  if (auth.status === 'loading') {
    return (
      <main className="flex min-h-dvh items-center justify-center text-sm text-slate-500">
        <p role="status">Đang tải…</p>
      </main>
    );
  }
  if (auth.status === 'anonymous') {
    return (
      <>
        <LoginForm
          notice={unreachable ? 'Không kết nối được máy chủ. Vui lòng thử lại sau.' : auth.notice}
          onLoggedIn={(user) => {
            setUnreachable(false);
            setAuth({ status: 'authenticated', user });
          }}
        />
      </>
    );
  }
  return <ChatApp key={auth.user.id} user={auth.user} onLogout={() => void logout()} />;
}
