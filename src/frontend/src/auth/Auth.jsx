import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { api, changeAuthEpoch } from '../lib/api.js';

const AuthContext = createContext(null);
export function useAuth() { return useContext(AuthContext); }

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState('Loading your account…');
  const [error, setError] = useState('');
  const loggingOut = useRef(false);

  useEffect(() => {
    let active = true;
    function unauthorized() {
      changeAuthEpoch();
      setUser(null);
    }
    window.addEventListener('aurajournal:unauthorized', unauthorized);
    api('/api/auth/me')
      .then((value) => { if (active) setUser(value); })
      .catch((failure) => {
        if (active && failure.status !== 401) setError('Could not reach AuraJournal. Check the API and database, then retry.');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => {
      active = false;
      window.removeEventListener('aurajournal:unauthorized', unauthorized);
    };
  }, []);

  async function authenticate(action, credentials) {
    const account = await api(`/api/auth/${action}`, { method: 'POST', body: credentials });
    changeAuthEpoch();
    setUser(account);
    return account;
  }

  async function logout() {
    if (loggingOut.current) return;
    loggingOut.current = true;
    changeAuthEpoch();
    setLoading('Logging out…');
    setUser(null);
    setError('');
    try {
      await api('/api/auth/logout', { method: 'POST', body: {} });
    } catch {
      setError('Logout could not be confirmed by the server. Retry before leaving this browser.');
    } finally {
      loggingOut.current = false;
      setLoading(false);
    }
  }

  if (loading) return <main className="page" role="status">{loading}</main>;
  if (error) return (
    <main className="page" role="alert">
      <p>{error}</p>
      <button onClick={() => window.location.reload()}>Retry connection</button>
      <button onClick={logout}>Retry logout</button>
    </main>
  );
  return <AuthContext.Provider value={{ user, authenticate, logout }}>{children}</AuthContext.Provider>;
}

export function PrivatePage({ children }) {
  const { user } = useAuth();
  return user ? children : <Navigate to="/login" replace />;
}

export function GuestPage({ children }) {
  const { user } = useAuth();
  return user ? <Navigate to="/" replace /> : children;
}
