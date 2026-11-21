import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { generateSavedReflection, readSavedReflection } from './reflectionApi.js';
import { addDays, parseDateKey, toDateKey } from './week.js';

function shortDate(key) {
  return parseDateKey(key).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function savedAt(value) {
  const date = new Date(value);
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

export default function SavedReflection({ periodStart }) {
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  const active = useRef(null);
  useEffect(() => {
    const controller = new AbortController();
    active.current = controller;
    readSavedReflection(periodStart, { signal: controller.signal }).then((data) => {
      if (!controller.signal.aborted) setState({ data, loading: false, error: '' });
    }).catch((error) => {
      if (!controller.signal.aborted) setState({ data: null, loading: false,
        error: error.status === 404 ? '' : 'Could not load your saved reflection. Try again.' });
    });
    return () => active.current?.abort();
  }, [periodStart]);

  async function generate() {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setState((old) => ({ ...old, loading: true, error: '' }));
    try {
      const result = await generateSavedReflection(periodStart, { signal: controller.signal });
      if (controller.signal.aborted) return;
      // An empty period does not remove an earlier saved snapshot.
      if (result.entry_count === 0) {
        setState((old) => ({ ...old, loading: false, error: 'No journals on these dates. Your saved reflection is unchanged.' }));
        return;
      }
      setState({ data: { ...result, updated_at: new Date().toISOString() }, loading: false, error: '' });
    } catch (error) {
      if (!controller.signal.aborted) setState((old) => ({ ...old, loading: false,
        error: error.status === 409 ? 'Your journals changed. Generate again with the latest entries.'
          : old.data ? 'Could not save a new reflection. Your previous one is unchanged.'
            : 'Could not generate a reflection. Try again later.' }));
    }
  }

  const { data, loading, error } = state;
  const periodEnd = data?.period_end || toDateKey(addDays(parseDateKey(periodStart), 6));
  const range = `${shortDate(periodStart)} – ${shortDate(periodEnd)}`;

  if (!data && !loading) {
    return (
      <section className="saved-reflection saved-reflection-empty" aria-labelledby="saved-reflection-heading">
        <div className="saved-reflection-head">
          <span className="aj-kicker">Saved reflection</span>
          <h2 id="saved-reflection-heading">No reflection for {range}</h2>
          {error && <p className="saved-reflection-error" role="alert">{error}</p>}
        </div>
        <button type="button" className="aj-btn" onClick={generate}>{error ? 'Try again' : 'Generate'}</button>
      </section>
    );
  }

  return (
    <section className="saved-reflection" aria-labelledby="saved-reflection-heading" aria-busy={loading}>
      <div className="saved-reflection-top">
        <div className="saved-reflection-head">
          <span className="aj-kicker">Saved reflection</span>
          <h2 id="saved-reflection-heading">{range}</h2>
        </div>
        {data?.updated_at && !loading && <span className="saved-reflection-meta">Saved {savedAt(data.updated_at)}</span>}
      </div>

      {loading ? (
        <div className="saved-reflection-loading" role="status">
          <span>{data ? 'Writing your reflection…' : 'Loading reflection…'}</span>
          <span className="aj-skeleton" aria-hidden="true" />
          <span className="aj-skeleton" aria-hidden="true" />
          <span className="aj-skeleton" aria-hidden="true" />
        </div>
      ) : (
        <>
          <p className="saved-reflection-summary">{data.summary}</p>
          <div className="saved-reflection-questions">
            <span className="aj-kicker">Questions for you</span>
            <ol>
              {data.questions.map((question, index) => (
                <li key={index}><span aria-hidden="true">{index + 1}</span>{question}</li>
              ))}
            </ol>
          </div>
        </>
      )}

      {error && <p className="saved-reflection-error" role="alert">{error}</p>}

      <div className="saved-reflection-foot">
        {data?.source_dates?.length > 0 ? (
          <div className="saved-reflection-sources">
            <span>From</span>
            {data.source_dates.map((day) => (
              <Link key={day} to={`/history?start=${day}&end=${day}`}>{shortDate(day)}</Link>
            ))}
          </div>
        ) : <span />}
        <button type="button" className="aj-btn aj-btn-outline" disabled={loading} onClick={generate}>Regenerate</button>
      </div>
    </section>
  );
}
