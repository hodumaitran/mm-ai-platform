'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, apiJson } from '../lib/api.ts';

type ManagedUser = {
  id: string;
  email: string;
  displayName: string;
  role: 'ADMIN' | 'USER';
  isActive: boolean;
  createdAt: string;
  lastLoginAt: string | null;
};

type UserPage = { items: ManagedUser[]; total: number; page: number; pageSize: number };

const PAGE_SIZE = 10;

export function AdminPanel({
  currentUserId,
  onClose,
}: {
  currentUserId: string;
  onClose: () => void;
}) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<UserPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [form, setForm] = useState({ email: '', displayName: '', password: '', role: 'USER' });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (target: number): Promise<void> => {
    try {
      setData(await apiJson<UserPage>('GET', `/users?page=${target}&pageSize=${PAGE_SIZE}`));
      setError(null);
    } catch {
      setError('Không tải được danh sách người dùng.');
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void load(page), 0);
    return () => clearTimeout(timer);
  }, [load, page]);

  const create = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setMessage(null);
    try {
      await apiJson('POST', '/users', { body: form });
      setForm({ email: '', displayName: '', password: '', role: 'USER' });
      setMessage('Đã tạo tài khoản.');
      await load(page);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) setMessage('Email đã tồn tại.');
      else if (caught instanceof ApiError && caught.status === 400) {
        setMessage('Thông tin không hợp lệ. Mật khẩu cần ít nhất 12 ký tự.');
      } else setMessage('Không tạo được tài khoản.');
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (user: ManagedUser): Promise<void> => {
    try {
      await apiJson('PATCH', `/users/${user.id}`, { body: { isActive: !user.isActive } });
      await load(page);
    } catch {
      setMessage('Không cập nhật được trạng thái tài khoản.');
    }
  };

  const pages = data === null ? 1 : Math.max(1, Math.ceil(data.total / data.pageSize));

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Quản lý người dùng"
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/30 p-4"
    >
      <div className="max-h-full w-full max-w-3xl overflow-y-auto rounded-xl bg-white p-5 shadow-lg">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Quản lý người dùng</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-sm hover:bg-slate-100"
          >
            Đóng
          </button>
        </div>
        <form onSubmit={(event) => void create(event)} className="mt-4 grid gap-2 sm:grid-cols-2">
          <input
            required
            type="email"
            aria-label="Email nhân viên"
            placeholder="Email"
            maxLength={254}
            value={form.email}
            onChange={(event) => setForm({ ...form, email: event.target.value })}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <input
            required
            aria-label="Tên hiển thị"
            placeholder="Tên hiển thị"
            maxLength={80}
            value={form.displayName}
            onChange={(event) => setForm({ ...form, displayName: event.target.value })}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <input
            required
            type="password"
            autoComplete="new-password"
            aria-label="Mật khẩu ban đầu"
            placeholder="Mật khẩu ban đầu (≥ 12 ký tự)"
            minLength={12}
            maxLength={256}
            value={form.password}
            onChange={(event) => setForm({ ...form, password: event.target.value })}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <select
            aria-label="Vai trò"
            value={form.role}
            onChange={(event) => setForm({ ...form, role: event.target.value })}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          >
            <option value="USER">Nhân viên</option>
            <option value="ADMIN">Quản trị viên</option>
          </select>
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:bg-slate-300 sm:col-span-2"
          >
            Tạo tài khoản
          </button>
        </form>
        {message !== null && (
          <p role="status" className="mt-2 text-sm text-slate-700">
            {message}
          </p>
        )}
        {error !== null && (
          <p role="alert" className="mt-2 text-sm text-red-700">
            {error}
          </p>
        )}
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-slate-500">
              <tr>
                <th className="py-1 pr-3">Email</th>
                <th className="py-1 pr-3">Tên</th>
                <th className="py-1 pr-3">Vai trò</th>
                <th className="py-1 pr-3">Trạng thái</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {data?.items.map((user) => (
                <tr key={user.id} className="border-t border-slate-100">
                  <td className="py-2 pr-3 break-all">{user.email}</td>
                  <td className="py-2 pr-3">{user.displayName}</td>
                  <td className="py-2 pr-3">{user.role === 'ADMIN' ? 'Quản trị' : 'Nhân viên'}</td>
                  <td className="py-2 pr-3">{user.isActive ? 'Hoạt động' : 'Đã vô hiệu hóa'}</td>
                  <td className="py-2 text-right">
                    {user.id !== currentUserId && (
                      <button
                        type="button"
                        onClick={() => void toggle(user)}
                        className="rounded px-2 py-1 text-xs hover:bg-slate-100"
                      >
                        {user.isActive ? 'Vô hiệu hóa' : 'Kích hoạt'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
          <span>
            Trang {page}/{pages} · {data?.total ?? 0} tài khoản
          </span>
          <span className="space-x-1">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
              className="rounded px-2 py-1 hover:bg-slate-100 disabled:opacity-40"
            >
              Trước
            </button>
            <button
              type="button"
              disabled={page >= pages}
              onClick={() => setPage(page + 1)}
              className="rounded px-2 py-1 hover:bg-slate-100 disabled:opacity-40"
            >
              Sau
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
