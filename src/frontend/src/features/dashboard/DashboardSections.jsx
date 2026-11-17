import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import JournalCompanion from '../../components/ui/JournalCompanion.jsx';
import { moodPresentation, MOODS } from '../calendar/calendarModel.js';
import { entryTitle } from '../journal/entryText.js';
import { weekLabel } from '../reflection/week.js';
import { parseDateKey } from '../../lib/localDate.js';
import { companionMessage, dashboardPreview, journalDayKey, moodAnalytics, reflectionScope } from './dashboardModel.js';
import { useDashboardReflection } from './useDashboardReflection.js';

function PendingSection({ status }) {
  return <p className="dashboard-muted" role="status">{status === 'loading'
    ? 'Gathering your journal activity…' : 'Unavailable until your journals can be loaded. Use Refresh entries to try again.'}</p>;
}

export function Activity({ activity, month, status, todayKey }) {
  const monthLabel = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  return <section className="dashboard-activity" aria-label="Journaling activity" aria-busy={status === 'loading'}>
    {status !== 'ready' ? <PendingSection status={status} /> : <>
      <dl>
        <div><dt>Current streak</dt><dd>{activity.current.count}<span> {activity.current.count === 1 ? 'day' : 'days'}</span></dd></div>
        <div><dt>Longest streak</dt><dd>{activity.longest}<span> {activity.longest === 1 ? 'day' : 'days'}</span></dd></div>
        <div><dt>Journal entries</dt><dd>{activity.total}<span> in all</span></dd></div>
        <div><dt>Days journaled</dt><dd>{activity.monthDays}<span> in {monthLabel}</span></dd></div>
      </dl>
      <p className="dashboard-fine">{activity.current.count
        ? `Your streak continues through ${activity.current.throughKey === todayKey ? 'today' : 'yesterday'}.`
        : 'No current streak. A new page is always welcome.'} A day counts once, however many entries you save. Activity follows your journal dates.</p>
    </>}
  </section>;
}

export function ReflectionBody({ state, generate, reload }) {
  if (state.status === 'loading') return <p role="status" className="dashboard-muted">Creating your weekly reflection…</p>;
  if (state.status === 'error') return <div className="dashboard-reflection-error" role="alert">
    <p>{state.error}</p>
    {state.code !== 413 && <button type="button" className="aj-btn aj-btn-outline" onClick={state.code === 409 ? reload : generate}>
      {state.code === 409 ? 'Refresh entries' : 'Try again'}</button>}
  </div>;
  if (state.status === 'ready') return state.data.entry_count ? <div className="dashboard-reflection-result">
    <span className="aj-kicker">AI-generated · {state.data.entry_count} {state.data.entry_count === 1 ? 'entry' : 'entries'} dated this week</span>
    <p>{state.data.summary}</p>
    <ul>{state.data.highlights.map((highlight, index) => <li key={index}>{highlight.text}
      <span className="dashboard-highlight-sources">{highlight.entry_ids.map((id, source) => <Link key={id} to={`/journal/${encodeURIComponent(id)}`}>
        View entry{highlight.entry_ids.length > 1 ? ` ${source + 1}` : ''}</Link>)}</span>
    </li>)}</ul>
    <button type="button" className="aj-btn aj-btn-outline" onClick={generate}>Regenerate recap</button>
  </div> : <p className="dashboard-muted">No entries remain in this week. <button className="aj-btn aj-btn-quiet" type="button" onClick={reload}>Refresh entries</button></p>;
  return <div className="dashboard-reflection-invite">
    <p className="dashboard-fine">For a written recap, your journal text for the full week is sent to the AI service only when you choose Generate.</p>
    <button type="button" className="aj-btn aj-btn-outline" onClick={generate}>Generate weekly recap</button>
  </div>;
}

function WeeklyReflection({ week, userId, timezone, reload }) {
  const scope = reflectionScope(userId, week, timezone);
  const { state, generate } = useDashboardReflection({ scope, startKey: week.startKey, timezone, enabled: week.sources.length > 0 });
  return <ReflectionBody state={state} generate={generate} reload={reload} />;
}

export function WeeklyRecap({ week, status, userId, timezone, reload, onSelectDate }) {
  const delta = week.count - week.previous.count;
  const comparison = delta === 0 ? 'The same number of entries' : `${Math.abs(delta)} ${Math.abs(delta) === 1 ? 'entry' : 'entries'} ${delta > 0 ? 'more' : 'fewer'}`;
  return <section className="dashboard-week" aria-labelledby="dashboard-week-heading" aria-busy={status === 'loading'}>
    <span className="aj-kicker">This week · Monday to Sunday</span>
    <h2 id="dashboard-week-heading">A week in moments</h2>
    {status !== 'ready' ? <PendingSection status={status} /> : <>
      <p className="dashboard-fine">{weekLabel(parseDateKey(week.startKey))}</p>
      <p className="dashboard-week-story">{week.count
        ? <>You’ve kept <strong>{week.count} {week.count === 1 ? 'entry' : 'entries'}</strong> across <strong>{week.activeDays} {week.activeDays === 1 ? 'day' : 'days'}</strong> so far this week.</>
        : 'No entries dated Monday through today yet. There’s still space for a moment you’d like to keep.'}</p>
      <p className="dashboard-fine">{comparison} than at this point last week ({week.previous.count}).</p>
      <ol className="dashboard-week-days" aria-label="This week’s journal days">
        {week.days.map(day => <li key={day.key}>
          <button type="button" disabled={day.future} className={day.count ? 'has-entries' : ''}
            aria-label={`${parseDateKey(day.key).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}, ${day.future ? 'upcoming' : `${day.count} ${day.count === 1 ? 'entry' : 'entries'}`}`}
            onClick={() => onSelectDate(day.key)}>
            <span>{parseDateKey(day.key).toLocaleDateString(undefined, { weekday: 'narrow' })}</span>
            <span className="dashboard-week-mark" aria-hidden="true">{day.count ? '•' : '·'}</span>
          </button>
        </li>)}
      </ol>
      {week.sources.length > 0 && <WeeklyReflection week={week} userId={userId} timezone={timezone} reload={reload} />}
    </>}
  </section>;
}

export function MoodAnalytics({ byDay, todayKey, status, timezone, moodsByEntry }) {
  const [period, setPeriod] = useState(7);
  const analytics = useMemo(() => moodAnalytics(byDay, todayKey, period, moodsByEntry), [byDay, todayKey, period, moodsByEntry, timezone]);
  return <section className="dashboard-moods" aria-labelledby="dashboard-moods-heading" aria-busy={status === 'loading'}>
    <div className="dashboard-section-heading"><div><span className="aj-kicker">Room to reflect</span><h2 id="dashboard-moods-heading">Your moods, gently noticed</h2></div>
      <div className="dashboard-period" role="group" aria-label="Mood analytics period">{[7, 30].map(days => <button type="button" key={days}
        aria-pressed={period === days} disabled={status !== 'ready'} onClick={() => setPeriod(days)}>{days} days</button>)}</div>
    </div>
    {status !== 'ready' ? <PendingSection status={status} /> : <>
      <p className="dashboard-fine">Last {period} days, including today · independent of the calendar month.</p>
      {analytics.classified === 0 ? <div className="dashboard-mood-unavailable">
        <div className="dashboard-mood-palette" aria-hidden="true">{Object.entries(MOODS).map(([key, mood]) => <span key={key} style={{ background: mood.color }} />)}</div>
        <p>{analytics.total ? 'Mood data isn’t available for these entries yet.' : 'No journals in this period yet.'}</p>
        <p className="dashboard-muted">{analytics.total ? `${analytics.total} ${analytics.total === 1 ? 'entry has' : 'entries have'} no saved mood classification. ` : ''}Your words and activity are here; mood patterns will appear when saved moods are available.</p>
      </div> : <>
        <p>Most recorded: <strong>{analytics.mostFrequent.join(' / ')}</strong>{analytics.mostFrequent.length > 1 ? ' (tied)' : ''}.</p>
        <ul className="dashboard-mood-distribution">{analytics.distribution.map(item => <li key={item.key}>
          <span>{item.label}</span><span className="dashboard-mood-track" aria-hidden="true"><span style={{ width: `${100 * item.count / analytics.classified}%`, background: item.color }} /></span>
          <span>{item.count}</span>
        </li>)}</ul>
        <p className="dashboard-fine">{analytics.classified} classified · {analytics.missing} without a saved mood. Bar lengths show the share of classified entries.</p>
        <ol className="dashboard-mood-timeline" aria-label="Daily mood history">{analytics.timeline.map(day => <li key={day.key}
          aria-label={`${day.key}: ${day.moods.length ? day.moods.map(key => MOODS[key].label).join(', ') : day.count ? 'mood unavailable' : 'no entries'}`}>
          {day.moods.length ? day.moods.map(key => <span key={key} style={{ background: MOODS[key].color }} aria-hidden="true" />) : <span className="dashboard-mood-gap" aria-hidden="true" />}
          <time dateTime={day.key}>{parseDateKey(day.key).getDate()}</time>
        </li>)}</ol>
        <p className="dashboard-fine">Each day shows its recorded categories without ranking emotions.</p>
      </>}
    </>}
  </section>;
}

export function RecentEntries({ entries, status, moodsByEntry = new Map() }) {
  return <section className="dashboard-recent" aria-labelledby="dashboard-recent-heading" aria-busy={status === 'loading'}>
    <div className="dashboard-section-heading"><div><span className="aj-kicker">A few pages back</span><h2 id="dashboard-recent-heading">Recent memories</h2></div><Link to="/history">All entries ↗</Link></div>
    {status !== 'ready' ? <PendingSection status={status} /> : entries.length === 0
      ? <p className="dashboard-muted">Your recent memories will be waiting here after you save your first entry.</p>
      : <ul className="dashboard-recent-list">{entries.slice(0, 3).map(entry => {
        const key = journalDayKey(entry), mood = moodPresentation(moodsByEntry.get(entry.id));
        return <li key={entry.id}><Link to={`/journal/${encodeURIComponent(entry.id)}`}>
          {key ? <time className="aj-kicker" dateTime={key}>{parseDateKey(key).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</time>
            : <span className="aj-kicker">Date unavailable</span>}
          <h3>{entryTitle(typeof entry.content === 'string' ? entry.content : '')}</h3>
          {entry.content && <p>{dashboardPreview(entry.content)}</p>}
          <span className="dashboard-recent-open">Open entry ↗{mood && <span style={{ background: mood.color }}>{mood.label}</span>}</span>
        </Link></li>;
      })}</ul>}
  </section>;
}

export function DashboardCompanion({ activity, week, status }) {
  return <JournalCompanion message={status === 'ready' ? companionMessage(activity.total, week.count, activity.current.count)
    : 'A little space to pause. Your memories will be here when your journals are ready.'}>
    <Link to="/">Make a little memory ↗</Link>
  </JournalCompanion>;
}
