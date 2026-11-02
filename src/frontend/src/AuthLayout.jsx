import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import './login.css';

const THEME_KEY = 'aurajournal-theme';
const THEMES = [
  {
    id: 'light',
    label: 'Light',
    icon: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
      </>
    ),
  },
  { id: 'dark', label: 'Dark', icon: <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" /> },
  {
    id: 'system',
    label: 'System',
    icon: (
      <>
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <path d="M8 21h8M12 17v4" />
      </>
    ),
  },
];

function storedTheme() {
  try {
    const id = localStorage.getItem(THEME_KEY);
    return THEMES.some((t) => t.id === id) ? id : 'light';
  } catch {
    return 'light';
  }
}

function useDark(theme) {
  const query = '(prefers-color-scheme: dark)';
  const [systemDark, setSystemDark] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setSystemDark(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return theme === 'dark' || (theme === 'system' && systemDark);
}

function ThemeSwitch({ theme, onChange }) {
  return (
    <div className="theme-switch" role="group" aria-label="Theme">
      <span
        className="pill"
        aria-hidden="true"
        style={{ translate: `${THEMES.findIndex((t) => t.id === theme) * 36}px 0` }}
      />
      {THEMES.map((t) => (
        <button
          key={t.id}
          type="button"
          className="theme-option"
          aria-pressed={theme === t.id}
          aria-label={t.label}
          title={t.label}
          onClick={() => onChange(t.id)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {t.icon}
          </svg>
        </button>
      ))}
    </div>
  );
}

/* Page shell shared by /login and /register: theme switch + centred column. */
export default function AuthLayout({ children }) {
  const [theme, setTheme] = useState(storedTheme);
  const dark = useDark(theme);

  function chooseTheme(id) {
    setTheme(id);
    try {
      localStorage.setItem(THEME_KEY, id);
    } catch {
      // Storage unavailable; the choice just won't persist.
    }
  }

  return (
    <main className={`login${dark ? ' dark' : ''}`}>
      <ThemeSwitch theme={theme} onChange={chooseTheme} />
      {children}
    </main>
  );
}

/* Placeholder: Google sign-in is not wired yet. */
export function GoogleButton() {
  function onClick() {
    // TODO: start the Google OAuth flow once the backend supports it.
  }

  return (
    <button type="button" className="login-google" onClick={onClick}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z" />
        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" />
        <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z" />
        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38Z" />
      </svg>
      Continue with Google
    </button>
  );
}

export function Divider() {
  return <div className="login-divider" aria-hidden="true">or</div>;
}

export function SwitchLink({ text, to, label }) {
  return (
    <p className="login-switch">
      {text} <Link to={to}>{label}</Link>
    </p>
  );
}

/* Outlined input with an sr-only label; the placeholder doubles as the label. */
export function Field({ id, label, error, ...props }) {
  return (
    <div className="login-field">
      <label htmlFor={id} className="sr-only">{label}</label>
      <input
        id={id}
        className="login-input"
        placeholder={label}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
        {...props}
      />
      {error && <p id={`${id}-error`} className="login-error">{error}</p>}
    </div>
  );
}

/* Shakes the form when validation refuses it. */
export function useShake() {
  const [shake, setShake] = useState(false);
  return {
    shake: () => setShake(true),
    className: shake ? ' shake' : '',
    onAnimationEnd: (event) => event.animationName === 'shake' && setShake(false),
  };
}
