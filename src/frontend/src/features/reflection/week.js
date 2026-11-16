import { addDays, toDateKey } from '../../lib/localDate.js';
export { addDays, parseDateKey, toDateKey } from '../../lib/localDate.js';

export function startOfWeek(date) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start;
}

export function weekDays(start) {
  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

export function weekLabel(start) {
  const end = addDays(start, 6);
  const sameMonth = start.getMonth() === end.getMonth();
  const startText = start.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const endText = end.toLocaleDateString(undefined, sameMonth ? { day: 'numeric' } : { day: 'numeric', month: 'short' });
  return `${startText} – ${endText}, ${end.getFullYear()}`;
}

export function entriesByDay(entries, start) {
  const days = new Map(weekDays(start).map((day) => [toDateKey(day), []]));
  for (const entry of entries) {
    const key = toDateKey(new Date(entry.created_at));
    days.get(key)?.push(entry);
  }
  return days;
}
