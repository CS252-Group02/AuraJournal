import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { useAuth } from '../auth/Auth.jsx';
import PageHeader from '../components/layout/PageHeader.jsx';
import { Skeleton, StatePanel } from '../components/ui/StatePanel.jsx';
import { entryTitle, entryTone } from '../features/journal/entryText.js';
import { useJournalEntries } from '../features/journal/useJournalEntries.js';
import { fetchWeeklyReflection, reflectionErrorMessage } from '../features/reflection/reflectionApi.js';
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

function MemoryStrip({ start, byDay, images }) {
  return (
    <section aria-labelledby="memories-heading">
      <div className="aj-section-head">
        <h2 id="memories-heading">Seven days of memories</h2>
        <span className="aj-kicker">Tap a day to open its entry</span>
      </div>
      <ol className="memory-strip">
        {weekDays(start).map((day) => {
          const key = toDateKey(day);
          const dayEntries = byDay.get(key) || [];
          const first = dayEntries.at(-1);
          const image = images.get(key);
          const name = day.toLocaleDateString(undefined, { weekday: 'long' });
          const tile = (
            <>
              <div className={`memory-art${first ? ` tone-${entryTone(first.id)}` : ' memory-art-empty'}`}>
                {image
                  ? <img src={image} alt={`Pixel-art memory for ${name}`} loading="lazy" />
                  : <span aria-hidden="true">{first ? '✦' : '·'}</span>}
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

function ReflectionBody({ state, onRetry }) {
  if (state.status === 'loading') {
    return (
      <div className="reflection-loading">
        <p className="aj-kicker" role="status">Gathering your week into a story…</p>
        <Skeleton count={3} className="reflection-skeleton" />
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <StatePanel icon="☁" tone="error" role="alert" title="Your reflection couldn’t be written"
        action={<button type="button" className="aj-btn" onClick={onRetry}>Try again</button>}>
        {state.error} Your entries are safe.
      </StatePanel>
    );
  }
  const { summary, highlights = [], questions = [] } = state.data;
  return (
    <>
      <section className="reflection-story" aria-labelledby="story-heading">
        <span className="aj-kicker">Your story · this week</span>
        <h2 id="story-heading">A week in reflection</h2>
        <p>{summary}</p>
      </section>
      <div className="reflection-columns">
        {highlights.length > 0 && (
          <section className="reflection-card" aria-labelledby="highlights-heading">
            <span className="aj-kicker" id="highlights-heading">Highlights</span>
            <ul className="reflection-highlights">
              {highlights.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </section>
        )}
        {questions.length > 0 && (
          <section className="reflection-card" aria-labelledby="questions-heading">
            <span className="aj-kicker" id="questions-heading">Questions to sit with</span>
            <ul className="reflection-questions">
              {questions.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </section>
        )}
      </div>
    </>
  );
}

export default function ReflectionPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const { entries, status, error, reload } = useJournalEntries();
  const [attempt, setAttempt] = useState(0);
  const [reflection, setReflection] = useState({ key: '', status: 'loading', data: null, error: '' });

  const thisWeek = startOfWeek(new Date());
  const requested = parseDateKey(params.get('week'));
  const start = requested && requested < thisWeek ? startOfWeek(requested) : thisWeek;
  const weekKey = toDateKey(start);
  const isCurrentWeek = weekKey === toDateKey(thisWeek);

  const byDay = useMemo(() => entriesByDay(entries, parseDateKey(weekKey)), [entries, weekKey]);
  const weekCount = [...byDay.values()].reduce((total, list) => total + list.length, 0);
  const shouldAsk = status === 'ready' && weekCount > 0;

  useEffect(() => {
    if (!shouldAsk) return undefined;
    const controller = new AbortController();
    setReflection({ key: weekKey, status: 'loading', data: null, error: '' });
    fetchWeeklyReflection(weekKey, { signal: controller.signal })
      .then((data) => setReflection({ key: weekKey, status: 'ready', data, error: '' }))
      .catch((problem) => {
        if (controller.signal.aborted) return;
        setReflection({ key: weekKey, status: 'error', data: null, error: reflectionErrorMessage(problem) });
      });
    return () => controller.abort();
  }, [shouldAsk, weekKey, weekCount, attempt]);

  function move(days) {
    const next = addDays(start, days);
    setParams(toDateKey(next) === toDateKey(thisWeek) ? {} : { week: toDateKey(next) });
  }

  const current = reflection.key === weekKey ? reflection : { status: 'loading' };
  const images = new Map((current.status === 'ready' ? current.data.days || [] : [])
    .filter((day) => day.image_url).map((day) => [day.date, day.image_url]));

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
      <StatePanel icon="✦" title={isCurrentWeek ? 'Nothing to reflect on yet' : 'A quiet week'}
        action={isCurrentWeek
          ? <Link className="aj-btn" to="/">Write today’s entry</Link>
          : <button type="button" className="aj-btn aj-btn-outline" onClick={() => move(-7)}>See the week before</button>}>
        {isCurrentWeek
          ? 'Write a few entries this week and your reflection will appear here.'
          : `You didn’t write any entries ${weekLabel(start)}.`}
      </StatePanel>
    );
  } else {
    content = (
      <>
        <ReflectionBody state={current} onRetry={() => setAttempt((value) => value + 1)} />
        <MemoryStrip start={start} byDay={byDay} images={images} />
      </>
    );
  }

  return (
    <main className="aj-page reflection-page">
      <div className="aj-inner">
        <PageHeader initial={user.email[0]?.toUpperCase()} />
        <header className="aj-title reflection-title">
          <div>
            <h1>Weekly reflection</h1>
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
