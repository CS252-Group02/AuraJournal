import { parseDateKey } from '../../lib/localDate.js';

// Original, unattributed AuraJournal reflections; no external quote service.
export const DAILY_REFLECTIONS = [
  'What part of today would you like to remember forever?',
  'There is room here for the ordinary moments, too.',
  'You do not need the perfect words. You can begin with what is here.',
  'A small moment of noticing can hold a whole day.',
  'Let this be a place where your thoughts can settle.',
  'Some days become clearer when we give them a little space.',
  'Your story can unfold one quiet page at a time.',
];

export function dailyReflection(dateKey) {
  const date = parseDateKey(dateKey);
  if (!date) return DAILY_REFLECTIONS[0];
  const day = Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
  return DAILY_REFLECTIONS[((day % DAILY_REFLECTIONS.length) + DAILY_REFLECTIONS.length) % DAILY_REFLECTIONS.length];
}
