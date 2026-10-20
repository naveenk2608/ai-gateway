import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, ApiError } from './api.js';

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
    <main className="narrow">
      <h1>AI Gateway</h1>
      <form className="card form" onSubmit={submit}>
        <h2>Log in</h2>
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
    </main>
  );
}
