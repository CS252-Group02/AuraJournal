import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';

import { useAuth } from '../auth/Auth.jsx';
import PageHeader from '../components/layout/PageHeader.jsx';
import { Skeleton, StatePanel } from '../components/ui/StatePanel.jsx';
import JournalCard, { longDate } from '../features/journal/JournalCard.jsx';
import { entryPreview, entryTitle, matchesSearch, readMinutes } from '../features/journal/entryText.js';
import { getLastOpened } from '../features/journal/recentlyOpened.js';
import { useJournalEntries } from '../features/journal/useJournalEntries.js';

const FILTERS = { all: 'All entries', ai: 'With AI reflection' };

function monthKey(value) {
  return new Date(value).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function groupByMonth(entries) {
  const groups = [];
  for (const entry of entries) {
    const key = monthKey(entry.created_at);
    const last = groups.at(-1);
    if (last?.key === key) last.entries.push(entry);
    else groups.push({ key, entries: [entry] });
  }
  return groups;
}

function RecentlyOpened({ entry, openedAt }) {
  return (
    <section className="history-recent" aria-labelledby="recent-heading">
      <div className="aj-section-head">
        <h2 id="recent-heading">Recently opened</h2>
        <span className="aj-kicker">Pick up where you left off</span>
      </div>
      <Link to={`/journal/${entry.id}`} className="recent-card">
        <div className="recent-paper" aria-hidden="true">
          <span className="aj-kicker">
            {new Date(entry.created_at).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}
          </span>
          <span className="recent-paper-title">{entryTitle(entry.content)}</span>
          <span className="recent-paper-line" /><span className="recent-paper-line short" />
        </div>
        <div className="recent-body">
          <span className="aj-kicker">
            Last opened · {new Date(openedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}
          </span>
          <h3>{entryTitle(entry.content)}</h3>
          {entryPreview(entry.content) && <p>{entryPreview(entry.content)}</p>}
          <div className="recent-meta">
            <span>{longDate(entry.created_at)}</span>
            <span>{readMinutes(entry.content)} min read</span>
            <span className="recent-open">Open entry ↗</span>
          </div>
        </div>
      </Link>
    </section>
  );
}

export default function HistoryPage() {
  const { user } = useAuth();
  const { entries, status, error, reload } = useJournalEntries();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState(() => params.get('q') || '');
  const filter = params.get('filter') === 'ai' ? 'ai' : 'all';
  const sort = params.get('sort') === 'oldest' ? 'oldest' : 'newest';
  const notice = location.state?.notice;

  function update(key, value, fallback) {
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (!value || value === fallback) next.delete(key);
      else next.set(key, value);
      return next;
    }, { replace: true });
  }

  const urlQuery = params.get('q') || '';
  useEffect(() => {
    if (query.trim() !== urlQuery) update('q', query.trim(), '');
  }, [query]);

  const visible = useMemo(() => {
    const list = entries.filter((entry) => matchesSearch(entry, query) && (filter !== 'ai' || entry.ai_summary));
    return sort === 'oldest' ? [...list].reverse() : list;
  }, [entries, query, filter, sort]);

  const lastOpened = getLastOpened(user.id);
  const recentEntry = lastOpened && entries.find((entry) => entry.id === lastOpened.id);
  const searching = Boolean(query.trim()) || filter !== 'all';

  let content;
  if (status === 'loading') {
    content = <Skeleton count={6} className="history-grid" />;
  } else if (status === 'error') {
    content = (
      <StatePanel icon="⚠" tone="error" role="alert" title="Couldn’t load your journals"
        action={<button type="button" className="aj-btn" onClick={reload}>Try again</button>}>
        {error}
      </StatePanel>
    );
  } else if (entries.length === 0) {
    content = (
      <StatePanel icon="✦" title="No journals yet"
        action={<Link className="aj-btn" to="/">Write your first entry</Link>}>
        Everything you write will be kept here, newest first.
      </StatePanel>
    );
  } else {
    content = (
      <>
        {recentEntry && !searching && <RecentlyOpened entry={recentEntry} openedAt={lastOpened.openedAt} />}
        <section aria-labelledby="all-heading">
          <div className="aj-section-head">
            <h2 id="all-heading">{searching ? 'Results' : 'All entries'}</h2>
            <span className="visually-hidden" role="status">
              {visible.length} {visible.length === 1 ? 'entry' : 'entries'}
            </span>
          </div>
          {visible.length === 0 ? (
            <StatePanel title="Nothing matches"
              action={<button type="button" className="aj-btn aj-btn-quiet" onClick={() => { setQuery(''); setParams({}, { replace: true }); }}>Clear search</button>}>
              {query.trim() ? `No entries match “${query.trim()}”.` : 'No entries have an AI reflection yet.'}
            </StatePanel>
          ) : groupByMonth(visible).map((group) => (
            <div key={group.key} className="history-month">
              <h3 className="aj-kicker history-month-label">
                {group.key} · {group.entries.length} {group.entries.length === 1 ? 'entry' : 'entries'}
              </h3>
              <div className="history-grid">
                {group.entries.map((entry) => <JournalCard key={entry.id} entry={entry} />)}
              </div>
            </div>
          ))}
        </section>
      </>
    );
  }

  return (
    <main className="aj-page history-page">
      <div className="aj-inner">
        <PageHeader initial={user.email[0]?.toUpperCase()} />
        <header className="aj-title">
          <h1>Your journal history</h1>
        </header>

        {notice && <p className="aj-notice" role="status">{notice}</p>}

        <div className="history-toolbar">
          <label className="aj-search">
            <span className="visually-hidden">Search your journals</span>
            <span aria-hidden="true">⌕</span>
            <input type="search" value={query} placeholder="Search your memories, moments, moods…"
              onChange={(event) => setQuery(event.target.value)} disabled={status !== 'ready'} />
          </label>
          <label className="aj-select">
            <span className="visually-hidden">Show</span>
            <select value={filter} onChange={(event) => update('filter', event.target.value, 'all')} disabled={status !== 'ready'}>
              {Object.entries(FILTERS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <button type="button" className="aj-btn aj-btn-outline" disabled={status !== 'ready'}
            onClick={() => update('sort', sort === 'newest' ? 'oldest' : 'newest', 'newest')}>
            {sort === 'newest' ? '↓ Newest first' : '↑ Oldest first'}
          </button>
        </div>

        {content}
      </div>
    </main>
  );
}
