import { useState } from 'react';
import AuthLayout, { Field, SwitchLink, useShake } from './AuthLayout.jsx';
import { useAuth } from './Auth.jsx';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function Register() {
  const [form, setForm] = useState({ email: '', password: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const { authenticate } = useAuth();
  const [errors, setErrors] = useState({});
  const refuse = useShake();

  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    const next = {};
    if (!EMAIL.test(form.email.trim())) next.email = 'Enter a valid email.';
    if (form.password.length < 8 || form.password.length > 128) next.password = 'Use 8–128 characters.';
    if (form.confirm !== form.password) next.confirm = 'Passwords do not match.';
    setErrors(next);

    if (Object.keys(next).length > 0) {
      refuse.shake();
      return;
    }

    setBusy(true);
    setMessage('');
    try {
      await authenticate('register', { email: form.email, password: form.password });
    } catch (error) {
      setMessage(error.status ? error.message : 'Could not connect. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      <form className={`login-form reveal${refuse.className}`} onSubmit={submit} onAnimationEnd={refuse.onAnimationEnd} noValidate>
        <h1 className="login-title">Create account</h1>

        <Field id="email" label="Email" type="email" autoComplete="email" value={form.email} onChange={set('email')} error={errors.email} />
        <Field id="password" label="Password" type="password" autoComplete="new-password" value={form.password} onChange={set('password')} error={errors.password} />
        <Field id="confirm" label="Confirm password" type="password" autoComplete="new-password" value={form.confirm} onChange={set('confirm')} error={errors.confirm} />

        <p role="alert" className="login-error">{message}</p>
        <button type="submit" className="login-button" disabled={busy}>{busy ? 'Creating account…' : 'Register'}</button>
        <SwitchLink text="Have an account?" to="/login" label="Log in" />
      </form>
    </AuthLayout>
  );
}
