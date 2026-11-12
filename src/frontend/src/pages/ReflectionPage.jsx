import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { useAuth } from '../auth/Auth.jsx';
import PageHeader from '../components/layout/PageHeader.jsx';
import { Skeleton, StatePanel } from '../components/ui/StatePanel.jsx';
import { entryTitle, entryTone } from '../features/journal/entryText.js';
import { useJournalEntries } from '../features/journal/useJournalEntries.js';
import { createRecapLoader } from '../features/reflection/reflectionApi.js';
import { addDays, entriesByDay, parseDateKey, startOfWeek, toDateKey, weekDays, weekLabel } from '../features/reflection/week.js';

function WeekPicker({ start, isCurrentWeek, onMove }) {
  return (
    <div className="week-picker" role="group" aria-label="Choose a week">
      <button type="button" className="aj-btn aj-btn-outline" onClick={() => onMove(-7)} aria-label="Previous week">←</button>
      <span className="week-picker-label" aria-live="polite">{isCurrentWeek ? 'This week' : weekLabel(start)}</span>
      <button type="button" className="aj-btn aj-btn-outline" onClick={() => onMove(7)} disabled={isCurrentWeek} aria-label="Next week">→</button>
    </div>
  );
}

function MemoryStrip({ start, byDay }) {
  return (
    <section aria-labelledby="memories-heading">
      <div className="aj-section-head">
        <h2 id="memories-heading">Your week’s entries</h2>
        <span className="aj-kicker">Tap a day to open its entry</span>
      </div>
      <ol className="memory-strip">
        {weekDays(start).map((day) => {
          const key = toDateKey(day);
          const dayEntries = byDay.get(key) || [];
          const first = dayEntries[0];
          const name = day.toLocaleDateString(undefined, { weekday: 'long' });
          const tile = (
            <>
              <div className={`memory-art${first ? ` tone-${entryTone(first.id)}` : ' memory-art-empty'}`}>
                <span aria-hidden="true">{first ? '✦' : '·'}</span>
              </div>
              <span className="memory-day">{day.toLocaleDateString(undefined, { weekday: 'short' })} {day.getDate()}</span>
              <span className="memory-caption">
                {first ? entryTitle(first.content) : 'No entry'}
                {dayEntries.length > 1 && ` +${dayEntries.length - 1}`}
              </span>
            </>
          );
          return (
            <li key={key}>
              {first
                ? <Link to={`/journal/${first.id}`} className="memory-tile" aria-label={`${name}: ${entryTitle(first.content)}`}>{tile}</Link>
                : <div className="memory-tile memory-tile-empty">{tile}</div>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function RecapBody({ state, onGenerate, onRefresh }) {
  if (state.status === 'loading') {
    return (
      <div className="reflection-loading">
        <p className="aj-kicker" role="status">Summarizing the events in your journals…</p>
        <Skeleton count={3} className="reflection-skeleton" />
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <StatePanel icon="☁" tone="error" role="alert" title="Your recap couldn’t be generated"
        action={state.code === 409
          ? <button type="button" className="aj-btn" onClick={onRefresh}>Refresh entries</button>
          : state.code !== 413 && <button type="button" className="aj-btn" onClick={onGenerate}>Try again</button>}>
        {state.error} Your entries are unchanged.
      </StatePanel>
    );
  }
  if (state.status !== 'ready') {
    return (
      <StatePanel icon="✦" title="What happened this week"
        action={<button type="button" className="aj-btn" onClick={onGenerate}>Generate weekly recap</button>}>
        Create a factual recap from this week’s entries. Their text will be sent to the AI service only when you select Generate.
      </StatePanel>
    );
  }
  const { summary, highlights, entry_count: count } = state.data;
  if (!count) return (
    <StatePanel title="No entries in this week" action={<button type="button" className="aj-btn" onClick={onRefresh}>Refresh entries</button>}>
      There are no journals to summarize. No AI request was needed.
    </StatePanel>
  );
  return (
    <>
      <section className="reflection-story" aria-labelledby="story-heading">
        <span className="aj-kicker">AI-generated · Based on {count} {count === 1 ? 'entry' : 'entries'}</span>
        <h2 id="story-heading">Your week at a glance</h2>
        <p>{summary}</p>
        <button type="button" className="aj-btn aj-btn-outline" onClick={onGenerate}>Regenerate</button>
      </section>
      {highlights.length > 0 && (
        <section className="reflection-card recap-events" aria-labelledby="highlights-heading">
          <h3 className="aj-kicker" id="highlights-heading">Key events</h3>
          <ul className="reflection-highlights">
            {highlights.map((item, index) => <li key={index}>
              <span>{item.text}</span>
              <span className="recap-sources">{item.entry_ids.map((id, source) => (
                <Link key={id} to={`/journal/${id}`}>View entry{item.entry_ids.length > 1 ? ` ${source + 1}` : ''}</Link>
              ))}</span>
            </li>)}
          </ul>
        </section>
      )}
    </>
  );
}

export default function ReflectionPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const { entries, status, error, reload } = useJournalEntries();
  const [recap, setRecap] = useState({ key: '', status: 'idle' });
  const [loader] = useState(() => createRecapLoader({ onChange: setRecap }));

  const thisWeek = startOfWeek(new Date());
  const requested = parseDateKey(params.get('week'));
  const start = requested && requested < thisWeek ? startOfWeek(requested) : thisWeek;
  const weekKey = toDateKey(start);
  const isCurrentWeek = weekKey === toDateKey(thisWeek);

  const byDay = useMemo(() => entriesByDay(entries, parseDateKey(weekKey)), [entries, weekKey]);
  const weekCount = [...byDay.values()].reduce((total, list) => total + list.length, 0);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  // Include source revisions/content, not just entry count: an edit must invalidate
  // the recap even if the number of entries in the week stays unchanged.
  const sourceKey = JSON.stringify([...byDay.values()].flat().map(
    (entry) => [entry.id, entry.created_at, entry.updated_at, entry.content],
  ));
  const scope = `${user.id}:${weekKey}:${timezone}:${sourceKey}`;
  useEffect(() => {
    loader.cancel();
    setRecap({ key: scope, status: 'idle' });
    return () => loader.cancel();
  }, [loader, scope]);
  function generate() {
    if (status === 'ready' && weekCount > 0) loader.run(scope, weekKey, timezone);
  }

  function move(days) {
    const next = addDays(start, days);
    setParams(toDateKey(next) === toDateKey(thisWeek) ? {} : { week: toDateKey(next) });
  }

  const current = recap.key === scope ? recap : { status: 'idle' };

  let content;
  if (status === 'loading') {
    content = <Skeleton count={3} className="reflection-skeleton" />;
  } else if (status === 'error') {
    content = (
      <StatePanel icon="⚠" tone="error" role="alert" title="Couldn’t load your journals"
        action={<button type="button" className="aj-btn" onClick={reload}>Try again</button>}>
        {error}
      </StatePanel>
    );
  } else if (weekCount === 0) {
    content = (
      <StatePanel icon="✦" title={isCurrentWeek ? 'Nothing to recap yet' : 'A quiet week'}
        action={isCurrentWeek
          ? <Link className="aj-btn" to="/">Write today’s entry</Link>
          : <button type="button" className="aj-btn aj-btn-outline" onClick={() => move(-7)}>See the week before</button>}>
        {isCurrentWeek
          ? 'Write an entry this week, then generate a recap whenever you choose.'
          : `You didn’t write any entries ${weekLabel(start)}.`}
      </StatePanel>
    );
  } else {
    content = (
      <>
        <RecapBody state={current} onGenerate={generate} onRefresh={reload} />
        <MemoryStrip start={start} byDay={byDay} />
      </>
    );
  }

  return (
    <main className="aj-page reflection-page">
      <div className="aj-inner">
        <PageHeader initial={user.email[0]?.toUpperCase()} />
        <header className="aj-title reflection-title">
          <div>
            <h1>Weekly recap</h1>
            <p>
              {weekLabel(start)}
              {status === 'ready' && weekCount > 0 && ` · ${weekCount} ${weekCount === 1 ? 'entry' : 'entries'}`}
            </p>
          </div>
          <WeekPicker start={start} isCurrentWeek={isCurrentWeek} onMove={move} />
        </header>
        {content}
      </div>
    </main>
  );
}
