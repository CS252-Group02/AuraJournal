import { useEffect, useState } from 'react';

import { api } from './api.js';
import { useAuth } from './Auth.jsx';

export default function App() {
  const { user, logout } = useAuth();
  const [content, setContent] = useState('');
  const [entries, setEntries] = useState([]);
  const [message, setMessage] = useState('Loading entries…');
  const [busy, setBusy] = useState(false);

  async function loadEntries() {
    try {
      setEntries(await api('/api/entries'));
      setMessage('');
    } catch (error) {
      setMessage(error.status ? error.message : 'Could not connect to AuraJournal. Please try again.');
    }
  }

  useEffect(() => {
    loadEntries();
  }, []);

  async function submitEntry(event) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      await api('/api/entries', {
        method: 'POST',
        body: { content },
      });
      setContent('');
      setMessage('Entry saved.');
      await loadEntries();
    } catch (error) {
      setMessage(error.message || 'Could not connect to AuraJournal.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <header>
        <div className="form-footer">
          <span>{user.email}</span>
          <button type="button" onClick={logout}>Log out</button>
        </div>
        <p className="eyebrow">A small space to reflect</p>
        <h1>AuraJournal</h1>
        <p className="intro">Write a thought and see it saved to your journal.</p>
      </header>

      <form className="entry-form" onSubmit={submitEntry}>
        <label htmlFor="entry">Today’s entry</label>
        <textarea
          id="entry"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder="What’s on your mind?"
          minLength={1}
          maxLength={5000}
          required
          rows={5}
        />
        <div className="form-footer">
          <span>{content.length}/5000</span>
          <button disabled={busy || !content.trim()}>{busy ? 'Saving…' : 'Save entry'}</button>
        </div>
      </form>

      <p className="status" role="status" aria-live="polite">{message}</p>

      <section aria-labelledby="entries-heading">
        <h2 id="entries-heading">Recent entries</h2>
        {entries.length === 0 && !message && <p className="empty">Your saved entries will appear here.</p>}
        <ul className="entries">
          {entries.map((entry) => (
            <li key={entry.id}>
              <p>{entry.content}</p>
              <time dateTime={entry.created_at}>{new Date(entry.created_at).toLocaleString()}</time>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
