import { useEffect, useRef, useState } from 'react';
import { generateSavedReflection, readSavedReflection } from './reflectionApi.js';

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
        setState((old) => ({ ...old, loading: false, error: 'No journals belong to these dates. Your saved reflection is unchanged.' }));
        return;
      }
      setState({ data: result, loading: false, error: '' });
    } catch (error) {
      if (!controller.signal.aborted) setState((old) => ({ ...old, loading: false,
        error: error.status === 409 ? 'Your journals changed. Generate again with the latest entries.'
          : 'Could not save a new reflection. Your previous reflection is unchanged. Try again later.' }));
    }
  }

  return <section className="aj-card" aria-labelledby="saved-reflection-heading">
    <h2 id="saved-reflection-heading">Saved weekly reflection</h2>
    <p>Seven journal days starting {periodStart}. Includes backdated journals assigned to these dates.</p>
    <p>Generating sends this period’s journal text to our AI provider. Saved results stay private to your account.</p>
    {state.loading && <p role="status">Loading reflection…</p>}
    {state.error && <p role="alert">{state.error}</p>}
    {state.data ? <>
      <p>{state.data.summary}</p>
      <ol>{state.data.questions.map((question, index) => <li key={index}>{question}</li>)}</ol>
      {state.data.source_dates?.length > 0 && <p>Source journal dates: {state.data.source_dates.join(', ')}</p>}
      <p>Saved snapshot. Generate again after changing your journals.</p>
    </> : !state.loading && <p>No reflection saved for this period.</p>}
    <button type="button" className="aj-btn aj-btn-outline" disabled={state.loading} onClick={generate}>
      {state.data ? 'Regenerate and save reflection' : 'Generate and save reflection'}
    </button>
  </section>;
}
