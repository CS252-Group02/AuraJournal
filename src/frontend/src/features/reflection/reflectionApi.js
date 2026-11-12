import { api } from '../../lib/api.js';

export function fetchWeeklyRecap(weekStartKey, timezone, { signal } = {}) {
  return api('/api/reflections/weekly', {
    method: 'POST', body: { start: weekStartKey, timezone }, signal,
  });
}

export function reflectionErrorMessage(error) {
  if (error?.status === 404) return 'Weekly recaps aren’t available on this server yet.';
  if (error?.status === 409) return 'Your journals changed while the recap was being generated. Refresh your entries before generating again.';
  if (error?.status === 413) return 'This week contains too much text for one recap. No entries were omitted or changed.';
  if (error?.status === 503) return 'The AI recap service is unavailable. Try again later.';
  if (error?.status === 502) return 'The AI returned an invalid recap. Please try again.';
  if (error?.status) return error.message;
  return 'Could not connect to AuraJournal. Check your connection and try again.';
}

// Explicit actions only; no generation on mount. Guards even transports that
// resolve after abort, and prevents an older retry from replacing a newer one.
export function createRecapLoader({ request = fetchWeeklyRecap, onChange }) {
  let generation = 0;
  let controller;
  function cancel() {
    generation += 1;
    controller?.abort();
    controller = undefined;
  }
  async function run(key, start, timezone) {
    cancel();
    const current = generation;
    const pending = new AbortController();
    controller = pending;
    onChange({ key, status: 'loading' });
    try {
      const data = await request(start, timezone, { signal: pending.signal });
      if (current !== generation || pending.signal.aborted) return;
      onChange({ key, status: 'ready', data });
    } catch (error) {
      if (current !== generation || pending.signal.aborted) return;
      onChange({ key, status: 'error', error: reflectionErrorMessage(error), code: error.status });
    } finally {
      if (current === generation) controller = undefined;
    }
  }
  return { run, cancel };
}
