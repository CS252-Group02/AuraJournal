import { useEffect, useState } from 'react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

export default function App() {
  const [content, setContent] = useState('');
  const [entries, setEntries] = useState([]);
  const [message, setMessage] = useState('Loading entries…');
  const [busy, setBusy] = useState(false);

  async function loadEntries() {
    try {
      const response = await fetch(`${API_URL}/api/entries`);
      if (!response.ok) throw new Error('Could not load entries.');
      setEntries(await response.json());
      setMessage('');
    } catch {
      setMessage('Could not connect to AuraJournal. Check that the API and database are running.');
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
      const response = await fetch(`${API_URL}/api/entries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || 'Could not save entry.');
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
