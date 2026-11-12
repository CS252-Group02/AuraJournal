import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { useAuth } from '../auth/Auth.jsx';
import { api } from '../lib/api.js';
import PageHeader from '../components/layout/PageHeader.jsx';
import { Skeleton, StatePanel } from '../components/ui/StatePanel.jsx';
import { entryTitle, readMinutes, wordCount } from '../features/journal/entryText.js';
import { forgetLastOpened, setLastOpened } from '../features/journal/recentlyOpened.js';
import { useJournalEntries } from '../features/journal/useJournalEntries.js';

const MAX_LENGTH = 5000;

function fullDate(value) {
  return new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}
function weekday(value) {
  return new Date(value).toLocaleDateString(undefined, { weekday: 'long' });
}
function clock(value) {
  return new Date(value).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
function summaryError(error) {
  if (error.status === 503) return 'The AI is resting right now. Try again in a little while.';
  if (error.status === 502) return 'The AI sent back something we couldn’t read. Try again.';
  return error.message || 'Could not connect to AuraJournal.';
}

function Reflection({ entry, onSummarize, state }) {
  if (entry.ai_summary) {
    return (
      <aside className="entry-note" aria-labelledby="note-heading">
        <span className="aj-kicker" id="note-heading">A note to myself ✦</span>
        <p className="entry-note-summary">{entry.ai_summary}</p>
        {entry.ai_reflection_question && <p className="entry-note-question">{entry.ai_reflection_question}</p>}
      </aside>
    );
  }
  return (
    <aside className="entry-note entry-note-empty" aria-labelledby="note-heading">
      <span className="aj-kicker" id="note-heading">A note to myself ✦</span>
      <p>Let AuraJournal gather this entry into a short reflection and a gentle question.</p>
      <button type="button" className="aj-btn" onClick={onSummarize} disabled={state.busy}>
        {state.busy ? 'Reflecting…' : 'Reflect on this entry'}
      </button>
      {state.error && <p className="aj-error" role="alert">{state.error}</p>}
    </aside>
  );
}

export default function EntryPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const { entries, setEntries, status, error, reload } = useJournalEntries();
  const entry = entries.find((item) => item.id === id);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failure, setFailure] = useState('');
  const [summary, setSummary] = useState({ busy: false, error: '' });
  const dialog = useRef(null);

  const foundId = entry?.id;
  useEffect(() => {
    if (foundId) setLastOpened(user.id, foundId);
  }, [foundId, user.id]);

  function replaceEntry(updated) {
    setEntries((current) => current.map((item) => (item.id === updated.id ? updated : item)));
  }

  function startEdit() {
    setDraft(entry.content);
    setEditing(true);
    setMessage('');
    setFailure('');
  }

  function cancelEdit() {
    setEditing(false);
    setFailure('');
  }

  async function saveEdit(event) {
    event.preventDefault();
    setBusy(true);
    setFailure('');
    try {
      replaceEntry(await api(`/api/entries/${entry.id}`, { method: 'PATCH', body: { content: draft } }));
      setEditing(false);
      setMessage('Changes saved.');
    } catch (problem) {
      setFailure(problem.message || 'Could not connect to AuraJournal.');
    } finally {
      setBusy(false);
    }
  }

  async function summarize() {
    setSummary({ busy: true, error: '' });
    try {
      const result = await api(`/api/entries/${entry.id}/summary`, { method: 'POST', body: {} });
      replaceEntry({ ...entry, ai_summary: result.summary, ai_reflection_question: result.reflection_question, ai_summarized_at: result.summarized_at });
      setSummary({ busy: false, error: '' });
    } catch (problem) {
      setSummary({ busy: false, error: summaryError(problem) });
    }
  }

  async function confirmDelete() {
    setBusy(true);
    setFailure('');
    try {
      await api(`/api/entries/${entry.id}`, { method: 'DELETE' });
      forgetLastOpened(user.id, entry.id);
      dialog.current?.close();
      navigate('/history', { replace: true, state: { notice: 'Entry deleted.' } });
    } catch (problem) {
      setFailure(problem.message || 'Could not connect to AuraJournal.');
      dialog.current?.close();
      setBusy(false);
    }
  }

  let content;
  if (status === 'loading') {
    content = <Skeleton count={2} className="entry-skeleton" />;
  } else if (status === 'error') {
    content = (
      <StatePanel icon="⚠" tone="error" role="alert" title="Couldn’t load this entry"
        action={<button type="button" className="aj-btn" onClick={reload}>Try again</button>}>
        {error}
      </StatePanel>
    );
  } else if (!entry) {
    content = (
      <StatePanel icon="?" title="Entry not found"
        action={<Link className="aj-btn" to="/history">See all entries</Link>}>
        It may have been deleted, or the link is wrong.
      </StatePanel>
    );
  } else {
    const edited = new Date(entry.updated_at) - new Date(entry.created_at) > 60_000;
    const unchanged = draft.trim() === entry.content;
    content = (
      <>
        <header className="aj-title entry-title">
          <h1>{entryTitle(entry.content)}</h1>
          <p>
            <time dateTime={entry.created_at}>{fullDate(entry.created_at)}</time>
            <span aria-hidden="true"> / </span>{weekday(entry.created_at)}
            <span aria-hidden="true"> · </span>{clock(entry.created_at)}
          </p>
        </header>

        {(message || failure) && (
          <p className={failure ? 'aj-error' : 'aj-notice'} role={failure ? 'alert' : 'status'}>{failure || message}</p>
        )}

        <div className="entry-layout">
          <article className="entry-paper">
            <span className="aj-kicker">Your entry ✦</span>
            {editing ? (
              <form onSubmit={saveEdit} className="entry-edit">
                <label htmlFor="entry-draft" className="visually-hidden">Edit entry</label>
                <textarea
                  id="entry-draft"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Escape' && !busy) cancelEdit(); }}
                  maxLength={MAX_LENGTH}
                  rows={10}
                  autoFocus
                  required
                />
                <div className="entry-actions">
                  <span className="entry-count">{draft.length}/{MAX_LENGTH}{entry.ai_summary && ' · Saving clears the AI note'}</span>
                  <button type="button" className="aj-btn aj-btn-quiet" onClick={cancelEdit} disabled={busy}>Cancel</button>
                  <button type="submit" className="aj-btn" disabled={busy || !draft.trim() || unchanged}>
                    {busy ? 'Saving…' : 'Save changes'}
                  </button>
                </div>
              </form>
            ) : (
              <>
                <div className="entry-text">{entry.content}</div>
                <Reflection entry={entry} onSummarize={summarize} state={summary} />
                <div className="entry-actions">
                  <button type="button" className="aj-btn aj-btn-outline" onClick={startEdit}>Edit</button>
                  <button type="button" className="aj-btn aj-btn-danger" onClick={() => dialog.current?.showModal()}>Delete</button>
                </div>
              </>
            )}
          </article>

          <aside className="entry-about" aria-labelledby="about-heading">
            <span className="aj-kicker" id="about-heading">About this entry</span>
            <dl>
              <div><dt>Written</dt><dd>{fullDate(entry.created_at)}, {clock(entry.created_at)}</dd></div>
              {edited && <div><dt>Edited</dt><dd>{fullDate(entry.updated_at)}, {clock(entry.updated_at)}</dd></div>}
              <div><dt>Length</dt><dd>{wordCount(entry.content)} words · {readMinutes(entry.content)} min read</dd></div>
              <div><dt>Visibility</dt><dd>Private journal</dd></div>
            </dl>
          </aside>
        </div>

        <dialog ref={dialog} className="aj-dialog" aria-labelledby="delete-heading" aria-describedby="delete-body"
          onCancel={(event) => { if (busy) event.preventDefault(); }}>
          <h2 id="delete-heading">Delete this entry?</h2>
          <p id="delete-body">This can’t be undone. The entry and its AI note will be removed for good.</p>
          <blockquote>{entry.content}</blockquote>
          <div className="entry-actions">
            <button type="button" className="aj-btn aj-btn-quiet" onClick={() => dialog.current?.close()} disabled={busy} autoFocus>Cancel</button>
            <button type="button" className="aj-btn aj-btn-danger-solid" onClick={confirmDelete} disabled={busy}>
              {busy ? 'Deleting…' : 'Delete entry'}
            </button>
          </div>
        </dialog>
      </>
    );
  }

  return (
    <main className="aj-page entry-page">
      <div className="aj-inner">
        <PageHeader initial={user.email[0]?.toUpperCase()} />
        <Link to="/history" className="aj-back">← All journal entries</Link>
        {content}
      </div>
    </main>
  );
}
