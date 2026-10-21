import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api.js';
import { Brand } from '../shell/Brand.js';

export function Login() {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: () => api('/admin/auth/login', { method: 'POST', body: { email, password } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me'] }),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    login.mutate();
  };

  const error = login.error;
  return (
    <main className="auth">
      <div className="auth-card">
        <div className="auth-brand">
          <Brand />
        </div>
        <form className="card form" onSubmit={submit} aria-labelledby="login-title">
          <div className="auth-heading">
            <h1 id="login-title">Log in</h1>
            <p className="muted small">Sign in with your admin account.</p>
          </div>
          <label>
            Email
            <input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && (
            <p className="error-text" role="alert">
              {error instanceof ApiError ? error.message : 'Login failed.'}
            </p>
          )}
          <button type="submit" className="primary" disabled={login.isPending}>
            {login.isPending ? 'Logging in…' : 'Log in'}
          </button>
        </form>
      </div>
    </main>
  );
}
