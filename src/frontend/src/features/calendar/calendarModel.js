import { addDays, parseDateKey, toDateKey } from '../../lib/localDate.js';

export const MOODS = {
  calm: { label: 'Calm', color: '#ddeadc' },
  happy: { label: 'Happy', color: '#f4e4bd' },
  blue: { label: 'Blue', color: '#dde8f3' },
  reflective: { label: 'Reflective', color: '#e9e0f2' },
  stressed: { label: 'Stressed', color: '#f3ddd7' },
};

export const HEATMAP = [
  { label: '0 entries', color: '#f8f7f1' },
  { label: '1 entry', color: '#fbe8ef' },
  { label: '2 entries', color: '#f7d4e2' },
  { label: '3 entries', color: '#f1b9cd' },
  { label: '4+ entries', color: '#eaa0bd' },
];

export function monthKey(date) {
  return toDateKey(date).slice(0, 7);
}

export function parseMonthKey(key) {
  return /^\d{4}-\d{2}$/.test(key || '') ? parseDateKey(`${key}-01`) : null;
}

export function shiftMonth(month, offset) {
  const next = new Date(month.getFullYear(), month.getMonth() + offset, 1);
  // Keep navigable months representable by the existing four-digit date keys.
  return next.getFullYear() >= 1000 && next.getFullYear() <= 9999 ? next : month;
}

export function dateInMonth(month, day) {
  const last = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  return new Date(month.getFullYear(), month.getMonth(), Math.min(day, last));
}

export function monthCells(month) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const leading = (first.getDay() + 6) % 7;
  const count = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const length = Math.ceil((leading + count) / 7) * 7;
  return Array.from({ length }, (_, index) => {
    const day = index - leading + 1;
    return day < 1 || day > count ? null : new Date(month.getFullYear(), month.getMonth(), day);
  });
}

export function groupEntriesByDay(entries) {
  const byDay = new Map();
  let invalidCount = 0;
  for (const entry of entries) {
    const date = typeof entry.created_at === 'string' && entry.created_at.trim()
      ? new Date(entry.created_at) : new Date(NaN);
    if (Number.isNaN(date.getTime())) { invalidCount++; continue; }
    const key = toDateKey(date);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(entry); // Keep complete objects and the API's newest-first order.
  }
  return { byDay, invalidCount };
}

export function heatLevel(count) {
  return Number.isFinite(count) ? Math.min(4, Math.max(0, Math.floor(count))) : 0;
}

export function moodPresentation(value) {
  return Object.hasOwn(MOODS, value) ? MOODS[value] : null;
}

export function currentStreak(byDay, today) {
  let cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const active = date => Boolean(byDay.get(toDateKey(date))?.length);
  if (!active(cursor)) cursor = addDays(cursor, -1);
  const throughKey = active(cursor) ? toDateKey(cursor) : null;
  let count = 0;
  while (active(cursor)) { count++; cursor = addDays(cursor, -1); }
  return { count, throughKey };
}
