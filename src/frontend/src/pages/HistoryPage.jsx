import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';

import { useAuth } from '../auth/Auth.jsx';
import PageHeader from '../components/layout/PageHeader.jsx';
import { Skeleton, StatePanel } from '../components/ui/StatePanel.jsx';
import JournalCard, { longDate } from '../features/journal/JournalCard.jsx';
import { entryPreview, entryTitle, readMinutes } from '../features/journal/entryText.js';
import { entrySearchPath, hasServerFilters, invalidRange, readSearchParams } from '../features/journal/journalSearch.js';
import { getLastOpened } from '../features/journal/recentlyOpened.js';
import { useJournalEntries } from '../features/journal/useJournalEntries.js';

const FILTERS = { all: 'All entries', ai: 'With AI reflection' };

function monthKey(entry) {
  const value = entry.journal_date ? `${entry.journal_date}T00:00:00` : entry.created_at;
  return new Date(value).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function groupByMonth(entries) {
  const groups = [];
  for (const entry of entries) {
    const key = monthKey(entry);
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
  const all = useJournalEntries();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const search = readSearchParams(params);
  const [query, setQuery] = useState(() => search.q);
  const filter = params.get('filter') === 'ai' ? 'ai' : 'all';
  const badRange = invalidRange(search);
  const serverSearch = hasServerFilters(search);
  const results = useJournalEntries(entrySearchPath(search));
  const source = serverSearch ? results : all;
  const notice = location.state?.notice;

  function update(key, value, fallback) {
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (!value || value === fallback) next.delete(key);
      else next.set(key, value);
      return next;
    }, { replace: true });
  }

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === search.q) return undefined;
    const timer = setTimeout(() => update('q', trimmed, ''), 300);
    return () => clearTimeout(timer);
  }, [query, search.q]);

  function clearSearch() {
    setQuery('');
    setParams({}, { replace: true });
  }

  const [shown, setShown] = useState(null);
  useEffect(() => {
    if (source.status === 'ready') setShown(source.entries);
  }, [source.status, source.entries]);
  const refreshing = source.status === 'loading' && shown !== null;
  const listed = source.status === 'ready' ? source.entries : shown || [];

  const visible = useMemo(
    () => listed.filter((entry) => filter !== 'ai' || entry.ai_summary),
    [listed, filter],
  );

  const lastOpened = getLastOpened(user.id);
  const recentEntry = lastOpened && all.entries.find((entry) => entry.id === lastOpened.id);
  const searching = Boolean(search.q || search.start || search.end) || filter !== 'all';
  const ready = all.status === 'ready';

  let emptyMessage = 'No entries have an AI reflection yet.';
  if (search.q) emptyMessage = `No entries match “${search.q}”.`;
  else if (search.start || search.end) emptyMessage = 'No entries in this date range.';

  let content;
  if (all.status === 'loading' || (source.status === 'loading' && !badRange && !refreshing)) {
    content = <Skeleton count={6} className="history-grid" />;
  } else if (all.status === 'error' || source.status === 'error') {
    const failed = all.status === 'error' ? all : source;
    content = (
      <StatePanel icon="⚠" tone="error" role="alert" title="Couldn’t load your journals"
        action={<button type="button" className="aj-btn" onClick={failed.reload}>Try again</button>}>
        {failed.error}
      </StatePanel>
    );
  } else if (all.entries.length === 0) {
    content = (
      <StatePanel icon="✦" title="No journals yet"
        action={<Link className="aj-btn" to="/">Write your first entry</Link>}>
        Everything you write will be kept here, newest first.
      </StatePanel>
    );
  } else if (badRange) {
    content = (
      <StatePanel title="Check your dates" role="alert"
        action={<button type="button" className="aj-btn aj-btn-quiet" onClick={() => { update('start', '', ''); update('end', '', ''); }}>Clear dates</button>}>
        The “from” date must be on or before the “to” date.
      </StatePanel>
    );
  } else {
    content = (
      <>
        {recentEntry && !searching && <RecentlyOpened entry={recentEntry} openedAt={lastOpened.openedAt} />}
        <section aria-labelledby="all-heading" aria-busy={refreshing} className={refreshing ? 'history-refreshing' : undefined}>
          <div className="aj-section-head">
            <h2 id="all-heading">{searching ? 'Results' : 'All entries'}</h2>
            <span className="visually-hidden" role="status">
              {visible.length} {visible.length === 1 ? 'entry' : 'entries'}
            </span>
          </div>
          {visible.length === 0 ? (
            <StatePanel title="Nothing matches"
              action={<button type="button" className="aj-btn aj-btn-quiet" onClick={clearSearch}>Clear search</button>}>
              {emptyMessage}
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
        <PageHeader />
        <header className="aj-title">
          <h1>Your journal history</h1>
        </header>

        {notice && <p className="aj-notice" role="status">{notice}</p>}

        <div className="history-toolbar">
          <label className="aj-search">
            <span className="visually-hidden">Search your journals</span>
            <span aria-hidden="true">⌕</span>
            <input type="search" value={query} placeholder="Search"
              onChange={(event) => setQuery(event.target.value)} disabled={!ready} />
          </label>
          <label className="aj-date">
            <span>From</span>
            <input type="date" value={search.start} max={search.end || undefined}
              onChange={(event) => update('start', event.target.value, '')} disabled={!ready} />
          </label>
          <label className="aj-date">
            <span>To</span>
            <input type="date" value={search.end} min={search.start || undefined}
              onChange={(event) => update('end', event.target.value, '')} disabled={!ready} />
          </label>
          <label className="aj-select">
            <span className="visually-hidden">Show</span>
            <select value={filter} onChange={(event) => update('filter', event.target.value, 'all')} disabled={!ready}>
              {Object.entries(FILTERS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <button type="button" className="aj-btn aj-btn-outline history-sort" disabled={!ready}
            onClick={() => update('sort', search.sort === 'newest' ? 'oldest' : 'newest', 'newest')}>
            <span aria-hidden={search.sort !== 'newest'}>↓ Newest first</span>
            <span aria-hidden={search.sort !== 'oldest'}>↑ Oldest first</span>
          </button>
        </div>

        {content}
      </div>
    </main>
  );
}
