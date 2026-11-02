import { useState } from 'react';
import AuthLayout, { Divider, Field, GoogleButton, SwitchLink, useShake } from './AuthLayout.jsx';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState({});
  const refuse = useShake();

  function submit(event) {
    event.preventDefault();
    const next = {};
    if (!username.trim()) next.username = 'Enter your username.';
    if (!password) next.password = 'Enter your password.';
    setErrors(next);

    if (Object.keys(next).length > 0) {
      refuse.shake();
      return;
    }

    // TODO: wire to the backend auth endpoint.
  }

  return (
    <AuthLayout>
      <form className={`login-form reveal${refuse.className}`} onSubmit={submit} onAnimationEnd={refuse.onAnimationEnd} noValidate>
        <h1 className="login-title">AuraJournal</h1>

        <Field
          id="username"
          label="Username"
          autoComplete="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          error={errors.username}
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

        <button type="submit" className="login-button">Log in</button>
        <Divider />
        <GoogleButton />
        <SwitchLink text="No account?" to="/register" label="Register" />
      </form>
    </AuthLayout>
  );
}
