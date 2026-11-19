import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { parseDateKey } from '../../lib/localDate.js';
import { entryTitle } from '../journal/entryText.js';
import { createMemoriesLoader, createMemoryImageLoader } from './pixelMemoriesApi.js';
import { mapPixelMemories, memoryDates } from './pixelMemoriesModel.js';

const titleOf = entry => entryTitle(typeof entry?.content === 'string' ? entry.content : '');
const journalUrl = entry => `/journal/${encodeURIComponent(entry.id)}`;
const dateLabel = key => parseDateKey(key).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

export function MemoryImage({ memory, label }) {
  const [state, setState] = useState({ status: 'loading' });
  const [loader] = useState(() => createMemoryImageLoader({ onChange: setState }));
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    loader.load(memory.image.content_url);
    return () => loader.cancel();
  }, [loader, memory.image.content_url, memory.image.id, attempt]);
  return <>
    <Link className="pixel-memory-art" to={journalUrl(memory.entry)} aria-label={`${label}: ${titleOf(memory.entry)}, open journal`}>
      {state.status === 'ready'
        ? <img src={state.url} width={128} height={128} alt={`Pixel illustration for ${titleOf(memory.entry)}`}
          onError={() => loader.unavailable(state.url)} />
        : <span role="status">{state.status === 'loading' ? 'Loading image…' : state.status === 'expired' ? 'Sign in to view' : 'Image unavailable'}</span>}
    </Link>
    {state.status === 'error' && <div className="pixel-memory-failure">
      <p role="status">{state.error}</p>
      <button type="button" onClick={() => setAttempt(value => value + 1)}>Retry image<span className="visually-hidden"> for {label}</span></button>
    </div>}
  </>;
}

export function MemoryDay({ day, status }) {
  const [selected, setSelected] = useState(null);
  const memory = day.images.find(item => item.entry_id === selected) || day.images[0];
  const entry = memory?.entry || day.entries[0];
  const label = dateLabel(day.key);
  const pending = status === 'loading';
  const unknown = status !== 'ready';
  let emptyLabel = 'No journal';
  if (status === 'journals-loading') emptyLabel = 'Loading journals…';
  else if (status === 'journals-error' || status === 'expired') emptyLabel = 'Journals unavailable';
  else if (entry) emptyLabel = pending ? 'Looking for images…' : unknown || day.invalid ? 'Images unavailable' : 'No pixel image yet';
  return <li className="pixel-memory-day" data-memory-date={day.key}>
    <time dateTime={day.key} title={label}>{parseDateKey(day.key).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</time>
    {memory ? <MemoryImage key={`${memory.entry_id}:${memory.image.id}`} memory={memory} label={label} />
      : <div className={`pixel-memory-art pixel-memory-empty${entry ? ' has-journal' : ''}`}>
        <span>{emptyLabel}</span>
      </div>}
    {entry ? <Link className="pixel-memory-caption" to={journalUrl(entry)}>{titleOf(entry)}</Link>
      : <p className="pixel-memory-caption">{status === 'ready' || status === 'loading' ? 'A little space in your story' : 'Your memories will be here'}</p>}
    {entry && !memory && !unknown && !day.invalid && <p className="pixel-memory-note">Journal saved</p>}
    {day.entries.length > 1 && <details className="pixel-memory-more">
      <summary>{day.entries.length - 1} more {day.entries.length === 2 ? 'journal' : 'journals'}
        {day.images.length > 1 && <> · {day.images.length - 1} more pixel {day.images.length === 2 ? 'memory' : 'memories'}</>}</summary>
      <ul>{day.entries.map(item => {
        const image = day.images.find(candidate => candidate.entry_id === item.id);
        return <li key={item.id}>
          <Link to={journalUrl(item)}>{titleOf(item)}</Link>
          {image ? <button type="button" aria-pressed={memory?.entry_id === item.id}
            onClick={() => setSelected(item.id)}>Show image<span className="visually-hidden">: {titleOf(item)}</span></button>
            : <span>{unknown || day.invalid ? 'Image status unavailable' : 'No pixel image yet'}</span>}
        </li>;
      })}</ul>
    </details>}
  </li>;
}

export function MemoryDays({ days, status }) {
  return <ol className="pixel-memory-days" aria-label="Seven calendar days of memories">
    {days.map(day => <MemoryDay key={day.key} day={day} status={status} />)}
  </ol>;
}

export function MemoriesGallery({ entries, asOf, onRefresh }) {
  const [state, setState] = useState({ status: 'loading' });
  const [loader] = useState(() => createMemoriesLoader({ onChange: setState }));
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    loader.load(asOf);
    return () => loader.cancel();
  }, [loader, asOf, attempt]);
  const { days, invalidCount } = useMemo(() => mapPixelMemories(
    state.status === 'expired' ? [] : entries, state.status === 'ready' ? state.records : [], asOf,
  ), [entries, state, asOf]);
  const imageCount = days.reduce((count, day) => count + day.images.length, 0);
  const entryCount = days.reduce((count, day) => count + day.entries.length, 0);
  return <>
    <div className="pixel-memory-status" aria-live="polite">
      {state.status === 'loading' && <p role="status">Gathering your stored pixel memories…</p>}
      {state.status === 'expired' && <p role="status">Your session changed. Sign in to view your memories.</p>}
      {state.status === 'error' && <p role="alert">{state.error}{' '}
        <button type="button" onClick={() => setAttempt(value => value + 1)}>Retry memories</button></p>}
      {state.status === 'ready' && invalidCount > 0 && <p role="status">Some image information could not be matched to your journals.{' '}
        <button type="button" onClick={onRefresh}>Refresh memories</button></p>}
      {state.status === 'ready' && !invalidCount && imageCount === 0 && <p role="status">{entryCount
        ? 'Your journals are here. No pixel images have been saved for these seven days yet.'
        : 'No journals are dated in these seven days. Choose an earlier end date or keep a new moment.'}</p>}
    </div>
    <MemoryDays days={days} status={state.status} />
  </>;
}

export default function PixelMemories({ entries, status, todayKey, timezone, userId, onRefresh }) {
  // null follows the shared local-day clock at midnight; historical selections
  // stay fixed. Calendar's month and selected date remain independent.
  const [chosenEnd, setChosenEnd] = useState(null);
  const asOf = chosenEnd && chosenEnd < todayKey ? chosenEnd : todayKey;
  const dates = memoryDates(asOf);
  const scope = JSON.stringify([userId, timezone, asOf, entries.map(entry =>
    [entry.id, entry.journal_date, entry.created_at, entry.updated_at, entry.content])]);
  return <section className="pixel-memories" aria-labelledby="pixel-memories-heading">
    <div className="pixel-memories-heading">
      <div><span className="aj-kicker">Seven days, little keepsakes</span><h2 id="pixel-memories-heading">Moments in Pixels</h2></div>
      <div className="pixel-memory-controls">
        <label>Seven days ending<input type="date" value={asOf} min="1000-01-07" max={todayKey}
          onChange={event => {
            const value = event.target.value;
            if (parseDateKey(value) && value >= '1000-01-07' && value <= todayKey) setChosenEnd(value === todayKey ? null : value);
          }} /></label>
        <button type="button" className="aj-btn aj-btn-outline" disabled={asOf === todayKey} onClick={() => setChosenEnd(null)}>Today</button>
        <button type="button" className="aj-btn aj-btn-quiet" disabled={status === 'loading'} onClick={onRefresh}>Refresh memories</button>
      </div>
    </div>
    <p className="pixel-memories-intro">Small illustrations from your saved journals. Open a memory to return to its words.</p>
    <p className="visually-hidden">{dateLabel(dates[0])} through {dateLabel(asOf)}. Journal dates determine placement.</p>
    {status === 'ready' ? <MemoriesGallery key={scope} entries={entries} asOf={asOf} onRefresh={onRefresh} />
      : <>
        <p role="status" className="pixel-memory-status">{status === 'loading' ? 'Loading journals for your memories…' : 'Memories are unavailable until your journals can be loaded. Use Refresh memories to try again.'}</p>
        <MemoryDays days={dates.map(key => ({ key, entries: [], images: [] }))} status={`journals-${status}`} />
      </>}
    <p className="pixel-memories-footnote">Stored images only · Nothing is generated when you open or refresh this gallery.</p>
  </section>;
}
