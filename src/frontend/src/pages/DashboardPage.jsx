import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/Auth.jsx';
import PageHeader from '../components/layout/PageHeader.jsx';
import { StatePanel } from '../components/ui/StatePanel.jsx';
import Calendar from '../features/calendar/Calendar.jsx';
import { currentStreak, groupEntriesByDay } from '../features/calendar/calendarModel.js';
import { useCalendarView } from '../features/calendar/useCalendarView.js';
import JournalCard from '../features/journal/JournalCard.jsx';
import { useJournalEntries } from '../features/journal/useJournalEntries.js';
import { parseDateKey } from '../lib/localDate.js';

function SelectedDayEntries({ dateKey, entries }) {
  const [visibleCount, setVisibleCount] = useState(20);
  const label = parseDateKey(dateKey).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  return (
    <section className="dashboard-day-entries" aria-labelledby="dashboard-day-heading">
      <div className="aj-section-head">
        <h2 id="dashboard-day-heading">{label}</h2>
        <p role="status">{entries.length} {entries.length === 1 ? 'journal' : 'journals'}</p>
      </div>
      {entries.length === 0 ? <StatePanel title="No journals on this date">
        Choose another day to revisit your entries.
      </StatePanel> : <>
        <ul className="dashboard-entry-list">
          {entries.slice(0, visibleCount).map(entry => <li key={entry.id}><JournalCard entry={entry} /></li>)}
        </ul>
        {visibleCount < entries.length && <button type="button" className="aj-btn aj-btn-outline"
          onClick={() => setVisibleCount(count => count + 20)}>Show more journals</button>}
      </>}
    </section>
  );
}

function DashboardContent({ user }) {
  const { entries, status, error, reload } = useJournalEntries();
  const view = useCalendarView();
  const { byDay, invalidCount } = useMemo(() => groupEntriesByDay(entries), [entries, view.timezone]);
  const streak = useMemo(() => currentStreak(byDay, view.today), [byDay, view.todayKey, view.timezone]);
  const ready = status === 'ready';

  return (
    <main className="aj-page dashboard-page">
      <div className="aj-inner">
        <PageHeader initial={user.email[0]?.toUpperCase()} />
        <header className="aj-title dashboard-title">
          <div><h1>Your journey</h1><p>Every day tells a story. Here’s yours.</p></div>
          {ready && <p className="dashboard-streak" role="status">
            {streak.count ? <>{streak.count}-day streak <span>through {streak.throughKey === view.todayKey ? 'today' : 'yesterday'}</span></> : 'No current streak'}
          </p>}
        </header>
        <nav className="dashboard-links" aria-label="Your journal">
          <Link to="/">Back to Main</Link>
          <Link to="/history">All journal entries</Link>
          <button type="button" className="aj-btn aj-btn-quiet" disabled={status === 'loading'} onClick={reload}>Refresh entries</button>
        </nav>
        {status === 'loading' && <p className="dashboard-status" role="status">Loading your journal activity…</p>}
        {status === 'error' && <StatePanel title="Couldn’t load your journals" tone="error" role="alert"
          action={<button type="button" className="aj-btn" onClick={reload}>Try again</button>}>{error}</StatePanel>}
        <Calendar month={view.month} todayKey={view.todayKey} selectedKey={view.selectedKey} mode={view.mode}
          byDay={byDay} status={status} onMonthChange={view.changeMonth} onToday={view.goToday}
          onModeChange={view.changeMode} onSelectDate={view.selectDate} />
        {ready && invalidCount > 0 && <p className="dashboard-status" role="status">
          {invalidCount} {invalidCount === 1 ? 'entry could' : 'entries could'} not be placed on the calendar because the date is unavailable. <Link to="/history">View them in History.</Link>
        </p>}
        {ready && entries.length === 0 && <StatePanel title="No journals yet" action={<Link className="aj-btn" to="/">Write your first entry</Link>}>
          Your saved journals will appear on the calendar.
        </StatePanel>}
        {ready && view.selectedKey && <SelectedDayEntries key={view.selectedKey} dateKey={view.selectedKey} entries={byDay.get(view.selectedKey) || []} />}
      </div>
    </main>
  );
}

export default function DashboardPage() {
  const { user } = useAuth();
  return <DashboardContent key={user.id} user={user} />;
}
