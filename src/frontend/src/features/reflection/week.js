const pad = (value) => String(value).padStart(2, '0');

export function toDateKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function parseDateKey(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || '');
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return toDateKey(date) === key ? date : null;
}

export function startOfWeek(date) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start;
}

export function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
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
