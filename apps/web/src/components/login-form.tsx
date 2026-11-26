'use client';

import { useState, type FormEvent } from 'react';
import { ApiError, apiJson, setCsrfToken } from '../lib/api.ts';

export type SessionUser = {
  id: string;
  email: string;
  displayName: string;
  role: 'ADMIN' | 'USER';
};

export function LoginForm({
  notice,
  onLoggedIn,
}: {
  notice: string | null;
  onLoggedIn: (user: SessionUser) => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await apiJson<{ user: SessionUser; csrfToken: string }>(
        'POST',
        '/auth/login',
        {
          body: { email, password },
          sessionOptional: true,
        },
      );
      setCsrfToken(result.csrfToken);
      setPassword('');
      onLoggedIn(result.user);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 429) {
        setError(
          `Quá nhiều lần đăng nhập sai. Vui lòng thử lại sau ${caught.retryAfter ?? 60} giây.`,
        );
      } else if (caught instanceof ApiError && caught.status === 401) {
        setError('Email hoặc mật khẩu không đúng, hoặc tài khoản đã bị vô hiệu hóa.');
      } else {
        setError('Không thể đăng nhập lúc này. Vui lòng thử lại sau.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="flex min-h-dvh items-center justify-center bg-slate-50 px-4">
      <form
        onSubmit={(event) => void submit(event)}
        className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <h1 className="text-xl font-semibold">MM AI</h1>
        <p className="mt-1 text-sm text-slate-500">Đăng nhập để sử dụng trợ lý AI nội bộ.</p>
        {notice !== null && (
          <p role="status" className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {notice}
          </p>
        )}
        <label className="mt-4 block text-sm font-medium" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          required
          maxLength={254}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
        />
        <label className="mt-3 block text-sm font-medium" htmlFor="password">
          Mật khẩu
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          maxLength={256}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
        />
        {error !== null && (
          <p role="alert" className="mt-3 text-sm text-red-700">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={submitting || email.trim() === '' || password === ''}
          className="mt-5 w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {submitting ? 'Đang đăng nhập…' : 'Đăng nhập'}
        </button>
        <p className="mt-4 text-xs text-slate-500">
          Tài khoản do quản trị viên cấp. Hệ thống không hỗ trợ tự đăng ký.
        </p>
      </form>
    </main>
  );
}
