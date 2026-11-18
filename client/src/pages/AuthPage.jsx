import { useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';

export default function AuthPage() {
  const { signIn } = useAuth();
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const isRegister = mode === 'register';
  const update = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const data = isRegister ? await api.register(form) : await api.login(form);
      signIn(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <section className="auth-hero">
        <div className="brand brand-lg">
          <span className="brand-mark">🌙</span> Quiet Hours
        </div>
        <h1>Protect the time that matters.</h1>
        <p>
          Tell the AI assistant when you want to sleep, study, or focus. It builds the schedule, flags conflicts, reminds
          you before each block, and coaches you toward a healthier week.
        </p>
        <ul className="feature-list">
          <li>✨ Plain-English scheduling powered by Claude</li>
          <li>⏰ Live reminders before every quiet block</li>
          <li>📊 Weekly quiet-time score with one-click fixes</li>
        </ul>
      </section>

      <form className="card auth-card" onSubmit={submit}>
        <h2>{isRegister ? 'Create your account' : 'Welcome back'}</h2>
        {isRegister && (
          <label>
            Name
            <input value={form.name} onChange={update('name')} autoComplete="name" required />
          </label>
        )}
        <label>
          Email
          <input type="email" value={form.email} onChange={update('email')} autoComplete="email" required />
        </label>
        <label>
          Password
          <input
            type="password"
            value={form.password}
            onChange={update('password')}
            autoComplete={isRegister ? 'new-password' : 'current-password'}
            minLength={isRegister ? 8 : undefined}
            required
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Please wait…' : isRegister ? 'Create account' : 'Sign in'}
        </button>
        <p className="muted center">
          {isRegister ? 'Already have an account?' : 'New here?'}{' '}
          <button type="button" className="link-btn" onClick={() => { setMode(isRegister ? 'login' : 'register'); setError(''); }}>
            {isRegister ? 'Sign in' : 'Create an account'}
          </button>
        </p>
      </form>
    </div>
  );
}
