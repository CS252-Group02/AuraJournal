import { currentStreak, moodPresentation, MOODS } from '../calendar/calendarModel.js';
import { startOfWeek, weekDays } from '../reflection/week.js';
import { addDays, parseDateKey, toDateKey } from '../../lib/localDate.js';

// A journal date is a calendar day, not a UTC timestamp. Only legacy records
// without that field fall back to the browser-local recording date.
export function journalDayKey(entry) {
  if (entry.journal_date != null) return parseDateKey(entry.journal_date) ? entry.journal_date : null;
  const date = typeof entry.created_at === 'string' && entry.created_at.trim() ? new Date(entry.created_at) : null;
  return date && Number.isFinite(date.getTime()) ? toDateKey(date) : null;
}

export function indexJournalDays(entries) {
  const byDay = new Map();
  let invalidCount = 0;
  for (const entry of entries) {
    const key = journalDayKey(entry);
    if (!key) { invalidCount++; continue; }
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(entry);
  }
  return { byDay, invalidCount };
}

export function activitySummary(entries, byDay, todayKey, displayedMonth) {
  const today = parseDateKey(todayKey);
  const days = [...byDay.keys()].filter(key => key <= todayKey).sort();
  let longest = 0, run = 0, previous;
  for (const key of days) {
    run = previous && toDateKey(addDays(parseDateKey(previous), 1)) === key ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = key;
  }
  return {
    total: entries.length,
    current: currentStreak(byDay, today),
    longest,
    monthDays: [...byDay.keys()].filter(key => key.startsWith(`${displayedMonth}-`) && key <= todayKey).length,
  };
}

function rangeCounts(byDay, start, endKey) {
  let count = 0, activeDays = 0;
  for (const date of weekDays(start)) {
    const key = toDateKey(date);
    if (key > endKey) break;
    const length = byDay.get(key)?.length || 0;
    count += length;
    if (length) activeDays++;
  }
  return { count, activeDays };
}

export function weeklyActivity(byDay, todayKey) {
  const today = parseDateKey(todayKey), start = startOfWeek(today);
  const previousStart = addDays(start, -7);
  const current = rangeCounts(byDay, start, todayKey);
  const previous = rangeCounts(byDay, previousStart, toDateKey(addDays(today, -7)));
  const days = weekDays(start).map(date => {
    const key = toDateKey(date);
    return { key, count: key <= todayKey ? byDay.get(key)?.length || 0 : 0, future: key > todayKey };
  });
  // Include every source in the API's full seven-day period in the request key,
  // even if a user has dated a journal ahead of today.
  const sources = weekDays(start).flatMap(date => byDay.get(toDateKey(date)) || []);
  return { startKey: toDateKey(start), ...current, previous, days, sources };
}

export function reflectionScope(userId, week, timezone) {
  return JSON.stringify([userId, week.startKey, timezone, week.sources.map(entry =>
    [entry.id, entry.journal_date, entry.created_at, entry.updated_at, entry.content])]);
}

// Classifications are supplied explicitly when that capability is available.
// Card tones and valence/arousal are deliberately not treated as mood labels.
export function moodAnalytics(byDay, todayKey, period, moodsByEntry = new Map()) {
  const days = Array.from({ length: period }, (_, i) => toDateKey(addDays(parseDateKey(todayKey), i - period + 1)));
  const counts = Object.fromEntries(Object.keys(MOODS).map(key => [key, 0]));
  let missing = 0, total = 0;
  const timeline = days.map(key => {
    const moods = new Set();
    for (const entry of byDay.get(key) || []) {
      total++;
      const mood = moodsByEntry.get(entry.id);
      if (moodPresentation(mood)) { counts[mood]++; moods.add(mood); }
      else missing++;
    }
    return { key, moods: [...moods], count: byDay.get(key)?.length || 0 };
  });
  const distribution = Object.entries(counts).filter(([, count]) => count).map(([key, count]) => ({ key, count, ...MOODS[key] }));
  const maximum = Math.max(0, ...distribution.map(item => item.count));
  return { total, missing, classified: total - missing, timeline, distribution,
    mostFrequent: distribution.filter(item => item.count === maximum).map(item => item.label) };
}

export function dashboardPreview(content, limit = 150) {
  const text = typeof content === 'string' ? content.trim().replace(/\s+/g, ' ') : '';
  const characters = Array.from(text);
  return characters.length > limit ? `${characters.slice(0, limit).join('').trimEnd()}…` : text;
}

export function companionMessage(total, weekCount, streak) {
  if (!total) return 'Welcome to your little corner of memories. Begin with one moment you’d like to keep.';
  if (streak) return 'You’ve been making space for your story. Is there a small moment you’d like to revisit?';
  if (weekCount) return 'A few words can hold a whole moment. Your recent memories are here whenever you need them.';
  return 'Your memories are here, whenever you want to return. There’s room for a new page at your own pace.';
}
