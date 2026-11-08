import { useEffect, useRef, useState } from 'react';

import { api } from './api.js';
import { useAuth } from './Auth.jsx';

export default function App() {
  const { user, logout } = useAuth();
  const [content, setContent] = useState('');
  const [entries, setEntries] = useState([]);
  const [message, setMessage] = useState('Loading entries…');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState('');
  const [pendingDelete, setPendingDelete] = useState(null);
  const [rowBusy, setRowBusy] = useState(false);
  const confirmDialog = useRef(null);

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

  function startEdit(entry) {
    setEditing(entry.id);
    setDraft(entry.content);
    setMessage('');
  }

  function cancelEdit() {
    setEditing(null);
    setDraft('');
  }

  async function saveEdit(event) {
    event.preventDefault();
    setRowBusy(true);
    setMessage('');
    try {
      const updated = await api(`/api/entries/${editing}`, { method: 'PATCH', body: { content: draft } });
      setEntries((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
      cancelEdit();
      setMessage('Entry updated.');
    } catch (error) {
      setMessage(error.message || 'Could not connect to AuraJournal.');
    } finally {
      setRowBusy(false);
    }
  }

  function askDelete(entry) {
    setPendingDelete(entry);
    confirmDialog.current?.showModal();
  }

  function closeDelete() {
    confirmDialog.current?.close();
  }

  async function confirmDelete() {
    const target = pendingDelete;
    setRowBusy(true);
    setMessage('');
    try {
      await api(`/api/entries/${target.id}`, { method: 'DELETE' });
      setEntries((current) => current.filter((entry) => entry.id !== target.id));
      if (editing === target.id) cancelEdit();
      setMessage('Entry deleted.');
      closeDelete();
    } catch (error) {
      setMessage(error.message || 'Could not connect to AuraJournal.');
      closeDelete();
    } finally {
      setRowBusy(false);
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
              {editing === entry.id ? (
                <form onSubmit={saveEdit}>
                  <label htmlFor={`edit-${entry.id}`} className="visually-hidden">Edit entry</label>
                  <textarea
                    id={`edit-${entry.id}`}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => { if (event.key === 'Escape') cancelEdit(); }}
                    maxLength={5000}
                    rows={4}
                    autoFocus
                    required
                  />
                  <div className="form-footer">
                    <span>{draft.length}/5000</span>
                    <div className="entry-actions">
                      <button type="button" className="secondary" onClick={cancelEdit} disabled={rowBusy}>Cancel</button>
                      <button disabled={rowBusy || !draft.trim() || draft.trim() === entry.content}>
                        {rowBusy ? 'Saving…' : 'Save changes'}
                      </button>
                    </div>
                  </div>
                </form>
              ) : (
                <>
                  <p>{entry.content}</p>
                  <div className="form-footer">
                    <time dateTime={entry.created_at}>{new Date(entry.created_at).toLocaleString()}</time>
                    <div className="entry-actions">
                      <button type="button" className="secondary" onClick={() => startEdit(entry)} disabled={rowBusy}>Edit</button>
                      <button type="button" className="danger" onClick={() => askDelete(entry)} disabled={rowBusy}>Delete</button>
                    </div>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      </section>

      <dialog
        ref={confirmDialog}
        className="confirm-dialog"
        aria-labelledby="confirm-heading"
        aria-describedby="confirm-body"
        onClose={() => setPendingDelete(null)}
      >
        <h2 id="confirm-heading">Delete this entry?</h2>
        <p id="confirm-body">This can’t be undone. The entry and its AI summary will be removed for good.</p>
        {pendingDelete && <blockquote>{pendingDelete.content}</blockquote>}
        <div className="entry-actions">
          <button type="button" className="secondary" onClick={closeDelete} disabled={rowBusy} autoFocus>Cancel</button>
          <button type="button" className="danger-solid" onClick={confirmDelete} disabled={rowBusy}>
            {rowBusy ? 'Deleting…' : 'Delete entry'}
          </button>
        </div>
      </dialog>
    </main>
  );
}
