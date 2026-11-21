import { api } from '../../lib/api.js';

export const MAX_QUESTION_LENGTH = 1000;

export function askJournals(question, { signal } = {}) {
  return api('/api/entries/ask', { method: 'POST', body: { question }, signal });
}

export function questionProblem(question) {
  const text = question.trim();
  if (!text) return 'Type a question first.';
  if (text.length > MAX_QUESTION_LENGTH) return `Keep your question under ${MAX_QUESTION_LENGTH} characters.`;
  return '';
}

export function sourceDayPath(day) {
  return `/history?start=${day}&end=${day}`;
}

export function qaErrorMessage(error) {
  if (error?.status === 409) return 'Your journals changed while answering. Ask again.';
  if (error?.status === 413) return 'Too much journal text matched. Try a narrower question.';
  if (error?.status === 422) return 'That question can’t be asked. Shorten it or remove unusual characters.';
  if (error?.status === 429) return 'You’ve asked a lot recently. Wait a moment and try again.';
  if (error?.status === 502) return 'The AI returned an invalid answer. Please try again.';
  if (error?.status === 503) return 'Answering is unavailable right now. Try again later.';
  if (error?.status) return error.message;
  return 'Could not connect to AuraJournal. Check your connection and try again.';
}

export function createAskLoader({ request = askJournals, onChange }) {
  let generation = 0;
  let controller;
  function cancel() {
    generation += 1;
    controller?.abort();
    controller = undefined;
  }
  async function ask(question) {
    const text = question.trim();
    const problem = questionProblem(text);
    if (problem) {
      onChange({ status: 'invalid', question: text, error: problem });
      return;
    }
    cancel();
    const current = generation;
    const pending = new AbortController();
    controller = pending;
    onChange({ status: 'loading', question: text });
    try {
      const data = await request(text, { signal: pending.signal });
      if (current !== generation || pending.signal.aborted) return;
      onChange({ status: data.status === 'answered' ? 'answered' : 'no-evidence', question: text, data });
    } catch (error) {
      if (current !== generation || pending.signal.aborted) return;
      onChange({ status: 'error', question: text, error: qaErrorMessage(error), code: error.status });
    } finally {
      if (current === generation) controller = undefined;
    }
  }
  return { ask, cancel };
}
