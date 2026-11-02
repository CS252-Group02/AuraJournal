import { useState } from 'react';
import AuthLayout, { Divider, Field, GoogleButton, SwitchLink, useShake } from './AuthLayout.jsx';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function Register() {
  const [form, setForm] = useState({ username: '', email: '', password: '', confirm: '' });
  const [errors, setErrors] = useState({});
  const refuse = useShake();

  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));

  function submit(event) {
    event.preventDefault();
    const next = {};
    if (!form.username.trim()) next.username = 'Enter a username.';
    if (!EMAIL.test(form.email.trim())) next.email = 'Enter a valid email.';
    if (form.password.length < 8) next.password = 'Use at least 8 characters.';
    if (form.confirm !== form.password) next.confirm = 'Passwords do not match.';
    setErrors(next);

    if (Object.keys(next).length > 0) {
      refuse.shake();
      return;
    }

    // TODO: wire to the backend register endpoint.
  }

  return (
    <AuthLayout>
      <form className={`login-form reveal${refuse.className}`} onSubmit={submit} onAnimationEnd={refuse.onAnimationEnd} noValidate>
        <h1 className="login-title">Create account</h1>

        <Field id="username" label="Username" autoComplete="username" value={form.username} onChange={set('username')} error={errors.username} />
        <Field id="email" label="Email" type="email" autoComplete="email" value={form.email} onChange={set('email')} error={errors.email} />
        <Field id="password" label="Password" type="password" autoComplete="new-password" value={form.password} onChange={set('password')} error={errors.password} />
        <Field id="confirm" label="Confirm password" type="password" autoComplete="new-password" value={form.confirm} onChange={set('confirm')} error={errors.confirm} />

        <button type="submit" className="login-button">Register</button>
        <Divider />
        <GoogleButton />
        <SwitchLink text="Have an account?" to="/login" label="Log in" />
      </form>
    </AuthLayout>
  );
}
