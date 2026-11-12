import { api } from '../../lib/api.js';

export function fetchWeeklyReflection(weekStartKey, { signal } = {}) {
  return api(`/api/reflections/weekly?start=${encodeURIComponent(weekStartKey)}`, { signal });
}

export function reflectionErrorMessage(error) {
  if (error?.status === 404) return 'Weekly reflections aren’t available on this server yet.';
  if (error?.status === 503) return 'The AI is resting right now and couldn’t write your reflection.';
  if (error?.status === 502) return 'The AI sent back something we couldn’t read.';
  if (error?.status) return error.message;
  return 'Could not connect to AuraJournal. Check your connection and try again.';
}
