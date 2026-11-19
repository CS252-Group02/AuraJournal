import { useSearchParams } from 'react-router-dom';
import { parseDateKey, toDateKey } from '../../lib/localDate.js';
import { useLocalDay } from '../../lib/useLocalDay.js';
import { dateInMonth, monthKey, parseMonthKey } from './calendarModel.js';

export function calendarViewState(params, todayKey) {
  const today = parseDateKey(todayKey);
  const requestedDate = parseDateKey(params.get('date'));
  const month = parseMonthKey(params.get('month')) || (requestedDate
    ? parseMonthKey(monthKey(requestedDate)) : new Date(today.getFullYear(), today.getMonth(), 1));
  return {
    today, month,
    selectedKey: requestedDate && monthKey(requestedDate) === monthKey(month) ? toDateKey(requestedDate) : null,
    mode: params.get('mode') === 'mood' ? 'mood' : 'heatmap',
  };
}

// Each transition reads the latest URL, including queued clicks, and preserves
// unrelated parameters. Selection follows the day number, clamped at month end.
export function calendarViewParams(previous, action, todayKey) {
  const next = new URLSearchParams(previous);
  const state = calendarViewState(previous, todayKey);
  if (action.type === 'month') {
    const month = parseMonthKey(action.month);
    if (!month) return next;
    next.set('month', monthKey(month));
    if (state.selectedKey) next.set('date', toDateKey(dateInMonth(month, parseDateKey(state.selectedKey).getDate())));
    else next.delete('date');
  } else if (action.type === 'date' || action.type === 'today') {
    const key = action.type === 'today' ? todayKey : action.key;
    if (!parseDateKey(key)) return next;
    next.set('month', key.slice(0, 7));
    next.set('date', key);
  } else if (action.type === 'mode' && ['mood', 'heatmap'].includes(action.mode)) {
    next.set('month', monthKey(state.month));
    next.set('mode', action.mode);
  }
  return next;
}

export function useCalendarView() {
  const [params, setParams] = useSearchParams();
  const { refresh, ...clock } = useLocalDay();

  function update(action, todayKey = clock.todayKey) {
    setParams(previous => calendarViewParams(previous, action, todayKey), { replace: true });
  }

  return {
    ...clock, ...calendarViewState(params, clock.todayKey),
    changeMonth(date) {
      update({ type: 'month', month: monthKey(date) });
    },
    selectDate(key) {
      update({ type: 'date', key });
    },
    changeMode(mode) { update({ type: 'mode', mode }); },
    goToday() {
      const current = refresh();
      update({ type: 'today' }, current.todayKey);
    },
  };
}
