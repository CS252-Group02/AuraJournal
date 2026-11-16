import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../auth/Auth.jsx';
import { parseDateKey } from '../lib/localDate.js';
import { useLocalDay } from '../lib/useLocalDay.js';
import { StatePanel } from '../components/ui/StatePanel.jsx';
import CalendarPreview from '../features/calendar/CalendarPreview.jsx';
import { currentStreak, groupEntriesByDay } from '../features/calendar/calendarModel.js';
import JournalCard from '../features/journal/JournalCard.jsx';
import { useJournalEntries } from '../features/journal/useJournalEntries.js';
import { dailyReflection } from '../features/journal/homeContent.js';

function Companion() {
  return <aside className="home-companion" aria-label="A gentle reminder">
    <p>A little moment, just for you.<br />How was your day?</p>
    <div className="home-companion-art" aria-hidden="true">
      <div className="home-companion-face"><span className="home-companion-eyes" /><span className="home-companion-blush" /></div>
    </div>
  </aside>;
}

function HomeContent({ user, logout }) {
  const { entries, setEntries, status, error, reload } = useJournalEntries();
  const { todayKey, timezone } = useLocalDay();
  const today = parseDateKey(todayKey);
  const { byDay, invalidCount } = useMemo(() => groupEntriesByDay(entries), [entries, timezone]);
  const streak = useMemo(() => currentStreak(byDay, today), [byDay, todayKey, timezone]);
  const [writing, setWriting] = useState(false), [content, setContent] = useState('');
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [failure, setFailure] = useState('');
  const editor = useRef(null), writeButton = useRef(null), request = useRef(null), active = useRef(false), saving = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; request.current?.abort(); };
  }, []);
  useEffect(() => { if (writing) editor.current?.focus(); }, [writing]);
  useEffect(() => {
    if (!content.trim()) return;
    const warn = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [content]);

  function closeWriting() {
    if (saving.current || (content.trim() && !window.confirm('Discard this unsaved journal draft?'))) return;
    setWriting(false); setContent(''); setFailure('');
    writeButton.current?.focus();
  }
  function protectDraft(event) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest('a');
    if (!link || link.target === '_blank' || link.getAttribute('href') === '/') return;
    if (saving.current || (content.trim() && !window.confirm('Leave this page and discard your unsaved journal draft?'))) event.preventDefault();
  }
  async function submitEntry(event) {
    event.preventDefault();
    if (saving.current || !content.trim() || content.length > 5000) return;
    saving.current = true; setBusy(true); setFailure(''); setNotice('');
    const controller = new AbortController(); request.current = controller;
    try {
      const saved = await api('/api/entries', { method: 'POST', body: { content }, signal: controller.signal });
      if (!active.current) return;
      setEntries(current => [saved, ...current.filter(entry => entry.id !== saved.id)]);
      setContent(''); setWriting(false); setNotice('Your journal is saved. A little moment, kept.');
      writeButton.current?.focus();
      // A GET started before this save may contain an older list. Refresh it once.
      if (status !== 'ready') await reload();
    } catch (problem) {
      if (active.current) setFailure(problem.message || 'Your journal could not be saved. Your draft is still here.');
    } finally {
      saving.current = false;
      if (active.current) setBusy(false);
      if (request.current === controller) request.current = null;
    }
  }
  const ready = status === 'ready';
  return (
    <main className="aj-page home-page" onClickCapture={protectDraft}>
      <header className="home-header">
        <Link className="home-brand" to="/">AuraJournal <span>/ Your private space</span></Link>
        <nav className="home-nav" aria-label="Your journal">
          <Link to="/dashboard">Dashboard</Link><Link to="/history">History</Link><Link to="/reflection">Weekly recap</Link>
        </nav>
        <details className="home-account" onKeyDown={event => {
          if (event.key === 'Escape') { event.currentTarget.open = false; event.currentTarget.querySelector('summary').focus(); }
        }}>
          <summary aria-label="Your account"><span aria-hidden="true">{user.email[0]?.toUpperCase()}</span></summary>
          <div className="home-account-menu"><span>Signed in as</span><p>{user.email}</p>
            <button type="button" className="aj-btn aj-btn-quiet" onClick={() => {
              if (!saving.current && (!content.trim() || window.confirm('Log out and discard your unsaved journal draft?'))) logout();
            }} disabled={busy}>Log out</button>
          </div>
        </details>
      </header>

      <section className="home-invitation" aria-labelledby="home-heading">
        <div className="home-date">
          <h1 id="home-heading">Welcome back. <span>A new page, a new moment.</span></h1>
          <time dateTime={todayKey}>
            <span className="home-date-label">{today.toLocaleDateString(undefined, { weekday: 'long' })} · {today.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
            <span className="home-date-number">{today.getDate()}</span>
            <span className="home-date-month">{today.toLocaleDateString(undefined, { month: 'long' })}</span>
          </time>
        </div>
        <div className="home-quote"><p className="aj-kicker">Quote of the day</p><blockquote>“{dailyReflection(todayKey)}”</blockquote></div>
        <div className="home-start">
          <Link className="home-record-link" to="/record" aria-label="Start journaling with your voice">
            <span className="home-record-halo" aria-hidden="true"><span className="home-record-circle"><span /></span></span>
            <span className="home-record-label">Start journaling</span>
          </Link>
          <p>Your thoughts have a place here.</p>
          <button ref={writeButton} className="home-write-link" type="button" aria-expanded={writing} aria-controls="home-writing"
            onClick={() => { if (writing) closeWriting(); else { setWriting(true); setNotice(''); } }}>Write instead <span aria-hidden="true">↗</span></button>
        </div>
        <Companion />
      </section>

      <div className="home-writing-wrap" id="home-writing">
        {writing && <form className="home-writing" onSubmit={submitEntry} aria-labelledby="home-writing-heading">
          <div className="home-section-head"><h2 id="home-writing-heading">A page of your own</h2>
            <button className="home-text-button" type="button" onClick={closeWriting} disabled={busy}>Close writing</button></div>
          <label htmlFor="home-entry">What’s on your mind?</label>
          <textarea id="home-entry" ref={editor} value={content} onChange={event => { setContent(event.target.value); setFailure(''); }}
            placeholder="Begin anywhere. This space is yours." maxLength={5000} required rows={7} readOnly={busy} aria-describedby="home-entry-help" />
          <div className="home-writing-footer"><span id="home-entry-help">{content.length}/5000 characters. Only saved when you choose.</span>
            <button className="aj-btn" disabled={busy || !content.trim()}>{busy ? 'Saving…' : 'Save journal'}</button></div>
          {failure && <p className="aj-error" role="alert">{failure}</p>}
        </form>}
        <p className="home-notice" role="status">{notice}</p>
      </div>

      <section className="home-journey" aria-labelledby="home-journey-heading">
        <div className="home-journey-heading"><div><span className="aj-kicker">Little moments, kept</span><h2 id="home-journey-heading">Your days, in your words.</h2></div>
          {ready && <p className="home-streak">{streak.count > 0 ? <><span aria-hidden="true">✦ </span>A {streak.count}-day journaling rhythm
            <small>through {streak.throughKey === todayKey ? 'today' : 'yesterday'}</small></> : 'A fresh page whenever you’re ready.'}</p>}
        </div>
        {status === 'error' && <StatePanel title="Your journals are taking a little longer" tone="error" role="alert"
          action={<button className="aj-btn" type="button" onClick={reload}>Try again</button>}>{error}</StatePanel>}
        {status === 'loading' && <p className="home-loading" role="status">Gathering your moments…</p>}
        <div className="home-activity">
          <CalendarPreview todayKey={todayKey} byDay={byDay} status={status} />
          <section className="home-recent" aria-labelledby="home-recent-heading" aria-busy={status === 'loading'}>
            <div className="home-section-head"><h2 id="home-recent-heading">Recent pages</h2><Link to="/history">View all entries <span aria-hidden="true">↗</span></Link></div>
            {ready && entries.length > 0 && <ul>{entries.slice(0, 3).map(entry => <li key={entry.id}><JournalCard entry={entry} /></li>)}</ul>}
            {ready && entries.length === 0 && <div className="home-empty"><span aria-hidden="true">✦</span><h3>Your story starts wherever you are.</h3>
              <p>Speak a little, or write a few words.<br />Your saved journals will find a home here.</p><Link to="/record">Make your first entry <span aria-hidden="true">↗</span></Link></div>}
            {!ready && <p className="home-recent-placeholder">{status === 'loading' ? 'Your recent pages will be here in a moment.' : 'Your journals will appear here once the connection is restored.'}</p>}
          </section>
        </div>
        {ready && invalidCount > 0 && <p className="home-calendar-note">Some entry dates are unavailable. You can still find those journals in <Link to="/history">History</Link>.</p>}
      </section>
      <footer className="home-footer">A little space to breathe. A place to be yourself.</footer>
    </main>
  );
}

export default function JournalPage() {
  const { user, logout } = useAuth();
  return <HomeContent key={user.id} user={user} logout={logout} />;
}
