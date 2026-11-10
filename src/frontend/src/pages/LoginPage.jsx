import { useState } from 'react';
import AuthLayout, { Field, SwitchLink, useShake } from '../auth/AuthLayout.jsx';
import { useAuth } from '../auth/Auth.jsx';

export default function Login() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const { authenticate } = useAuth();
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState({});
  const refuse = useShake();

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    const next = {};
    if (!email.trim()) next.email = 'Enter your email.';
    if (!password) next.password = 'Enter your password.';
    setErrors(next);

    if (Object.keys(next).length > 0) {
      refuse.shake();
      return;
    }

    setBusy(true);
    setMessage('');
    try {
      await authenticate('login', { email, password });
    } catch (error) {
      setMessage(error.status ? error.message : 'Could not connect. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      <form className={`login-form reveal${refuse.className}`} onSubmit={submit} onAnimationEnd={refuse.onAnimationEnd} noValidate>
        <h1 className="login-title">AuraJournal</h1>

        <Field
          id="email"
          label="Email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          error={errors.email}
        />
        <Field
          id="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          error={errors.password}
        />

        <p role="alert" className="login-error">{message}</p>
        <button type="submit" className="login-button" disabled={busy}>{busy ? 'Logging in…' : 'Log in'}</button>
        <SwitchLink text="No account?" to="/register" label="Register" />
      </form>
    </AuthLayout>
  );
}
