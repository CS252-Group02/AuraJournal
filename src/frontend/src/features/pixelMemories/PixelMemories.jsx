import { useEffect, useMemo, useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import { parseDateKey } from '../../lib/localDate.js';
import { entryTitle } from '../journal/entryText.js';
import { createMemoriesLoader, createMemoryImageLoader } from './pixelMemoriesApi.js';
import { generationLabel, mapPixelMemories, memoryDates, MIN_MEMORY_DATE, selectedMemory } from './pixelMemoriesModel.js';
import { api } from '../../lib/api.js';

const titleOf = memory => entryTitle(memory.entry.content);
const journalUrl = memory => `/journal/${memory.entry_id}`;
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
    <Link className="pixel-memory-art" to={journalUrl(memory)} aria-label={`${label}: ${titleOf(memory)}, open journal`}>
      {state.status === 'ready'
        ? <img src={state.url} width={128} height={128} alt={`Pixel illustration for ${titleOf(memory)}`}
          onError={() => loader.unavailable(state.url)} />
        : <span role="status">{state.status === 'loading' ? 'Loading image…' : state.status === 'expired' ? 'Sign in to view' : 'Image unavailable'}</span>}
    </Link>
    {state.status === 'error' && <div className="pixel-memory-failure">
      <p>{state.error}</p>
      <button type="button" onClick={() => setAttempt(value => value + 1)}>Retry image<span className="visually-hidden"> for {label}</span></button>
    </div>}
  </>;
}

function RetryArtwork({ item, onRetry }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const active = useRef(true), locked = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  if (!item.generation.retryable) return null;
  async function retry() {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try {
      await api(`/api/entries/${item.entry_id}/pixel-art/retry`, { method: 'POST', body: {} });
      if (active.current) await onRetry?.();
    } catch (failure) {
      if (active.current) setError(failure.message || 'Could not retry artwork.');
    } finally {
      locked.current = false;
      if (active.current) setBusy(false);
    }
  }
  return <span><button type="button" disabled={busy} onClick={retry}>{busy ? 'Queuing…' : 'Retry artwork'}</button>
    {error && <span role="alert">{error}</span>}</span>;
}

export function MemoryDay({ day, status, onRetry }) {
  const [selected, setSelected] = useState(null);
  const memory = selectedMemory(day.images, selected);
  // Latch the effective identity: a newly ready image, even an earlier one,
  // cannot silently change what the reader is viewing.
  useEffect(() => {
    if ((memory?.identity || null) !== selected) setSelected(memory?.identity || null);
  }, [memory?.identity, selected]);
  const index = memory ? day.images.findIndex(item => item.identity === memory.identity) : -1;
  const primary = memory || day.entries.find(item => item.generation.status === 'processing') ||
    day.entries.find(item => item.generation.status === 'pending') || day.entries[0];
  const label = dateLabel(day.key), positionId = `pixel-position-${day.key}`;
  const preparing = day.entries.filter(item => ['pending', 'processing'].includes(item.generation.status)).length;
  let emptyLabel = 'No journal';
  if (status === 'loading') emptyLabel = 'Loading memories…';
  else if (status === 'expired') emptyLabel = 'Sign in to view';
  else if (day.invalid || (status === 'error' && !primary)) emptyLabel = 'Memories unavailable';
  else if (primary) emptyLabel = generationLabel(primary.generation);
  function move(offset) {
    const next = day.images[index + offset];
    if (next) setSelected(next.identity);
  }
  return <li className="pixel-memory-day" data-memory-date={day.key}>
    <time dateTime={day.key} title={label}>{parseDateKey(day.key).toLocaleDateString(undefined,
      { weekday: 'short', month: 'short', day: 'numeric' })}</time>
    {memory ? <MemoryImage key={`${memory.identity}:${memory.entry.content}`} memory={memory} label={label} />
      : <div className={`pixel-memory-art pixel-memory-empty${primary ? ' has-journal' : ''}`}>
        <span data-generation-status={primary?.generation.status}>{emptyLabel}</span>
      </div>}
    {day.images.length > 1 && <div className="pixel-memory-carousel" role="group" aria-label={`Artwork navigation for ${label}`}
      onKeyDown={event => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault(); move(event.key === 'ArrowLeft' ? -1 : 1);
        }
      }}>
      <button type="button" aria-label={`Previous artwork for ${label}`} aria-describedby={positionId}
        disabled={index === 0} onClick={() => move(-1)}><span aria-hidden="true">←</span></button>
      <span id={positionId} aria-label={`Artwork ${index + 1} of ${day.images.length}`}>{index + 1} / {day.images.length}</span>
      <button type="button" aria-label={`Next artwork for ${label}`} aria-describedby={positionId}
        disabled={index === day.images.length - 1} onClick={() => move(1)}><span aria-hidden="true">→</span></button>
    </div>}
    {primary && <Link className="pixel-memory-caption" to={journalUrl(primary)}>{titleOf(primary)}</Link>}
    {primary && day.entries.length === 1 && <RetryArtwork item={primary} onRetry={onRetry} />}
    {memory && preparing > 0 && <p className="pixel-memory-note">{preparing} {preparing === 1 ? 'artwork' : 'artworks'} preparing</p>}
    {day.entries.length > 1 && <details className="pixel-memory-more">
      <summary>{day.entries.length} journals</summary>
      <ul>{day.entries.map(item => <li key={item.entry_id}>
        <Link to={journalUrl(item)}>{titleOf(item)}</Link>
        <span data-generation-status={item.generation.status}>{generationLabel(item.generation)}</span>
        <RetryArtwork item={item} onRetry={onRetry} />
      </li>)}</ul>
    </details>}
  </li>;
}

export function MemoryDays({ days, status, onRetry }) {
  return <ol className="pixel-memory-days" aria-label="Seven calendar days of memories" tabIndex={0}>
    {days.map(day => <MemoryDay key={day.key} day={day} status={status} onRetry={onRetry} />)}
  </ol>;
}

export default function PixelMemories({ todayKey, timezone, userId }) {
  const [chosenEnd, setChosenEnd] = useState(null);
  const asOf = chosenEnd && chosenEnd < todayKey ? chosenEnd : todayKey;
  const [state, setState] = useState({ status: 'loading', data: null });
  const [loader] = useState(() => createMemoriesLoader({ onChange: setState }));
  useEffect(() => {
    loader.load(asOf);
    return () => loader.cancel();
  }, [loader, asOf, timezone, userId]);
  const current = state.asOf === asOf ? state : { status: 'loading', data: null };
  const { days, invalidCount } = useMemo(() => mapPixelMemories(current.data?.entries || [],
    current.data?.feed, asOf), [current.data, asOf]);
  const count = days.reduce((sum, day) => sum + day.entries.length, 0);
  const dates = memoryDates(asOf);
  return <section className="pixel-memories" aria-labelledby="pixel-memories-heading">
    <header className="pixel-memories-heading aj-title">
      <h1 id="pixel-memories-heading">Moments in Pixels</h1>
      <div className="pixel-memory-controls">
        <label>Seven days ending<input type="date" value={asOf} min={MIN_MEMORY_DATE} max={todayKey}
          onChange={event => {
            const value = event.target.value;
            if (parseDateKey(value) && value >= MIN_MEMORY_DATE && value <= todayKey) setChosenEnd(value === todayKey ? null : value);
          }} /></label>
        <button type="button" className="aj-btn aj-btn-outline" disabled={asOf === todayKey}
          onClick={() => setChosenEnd(null)}>Today</button>
        <button type="button" className="aj-btn aj-btn-quiet" disabled={current.status === 'loading' || current.refreshing}
          onClick={() => loader.refresh()}>Refresh memories</button>
      </div>
    </header>
    <div className="pixel-memory-status">
      {current.status === 'loading' && <p role="status">Loading your pixel memories…</p>}
      {current.status === 'expired' && <p role="status">Your session changed. Sign in to view your memories.</p>}
      {current.status === 'error' && <p role="alert">{current.error}{' '}
        <button type="button" onClick={() => loader.refresh()}>Retry memories</button></p>}
      {invalidCount > 0 && <p role="status">Some journal information changed. Refresh memories to check again.</p>}
      {current.status === 'ready' && !count && !invalidCount && <p>No journals in these seven days.</p>}
      {current.windowExpired && <p role="status">Updates paused. Refresh memories to check again.</p>}
    </div>
    <p className="visually-hidden">{dateLabel(dates[0])} through {dateLabel(asOf)}. Illustrations from your saved journals.</p>
    <MemoryDays key={`${userId}:${timezone}:${asOf}`} days={days} status={current.status} onRetry={() => loader.refresh()} />
  </section>;
}
