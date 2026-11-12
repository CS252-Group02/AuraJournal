const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function formatEntryDate(value, now = new Date()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
  let day;
  if (days === 0) day = 'Today';
  else if (days === 1) day = 'Yesterday';
  else if (date.getFullYear() === now.getFullYear()) {
    day = date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  } else {
    day = date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }
  return `${day} · ${time}`;
}
