import { useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { parseDateKey, toDateKey } from '../../lib/localDate.js';
import { useLocalDay } from '../../lib/useLocalDay.js';
import { dateInMonth, monthKey, parseMonthKey, shiftMonth } from './calendarModel.js';

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

// Selection follows the day number, clamped at month end. Unrelated query
// parameters survive every transition.
export function calendarViewParams(previous, action, todayKey) {
  const next = new URLSearchParams(previous);
  const state = calendarViewState(previous, todayKey);
  if (action.type === 'month') {
    const month = action.offset === -1 || action.offset === 1 ? shiftMonth(state.month, action.offset) : parseMonthKey(action.month);
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
  // Router search-param callbacks do not queue like React state setters. Keep
  // pending URL transitions together until the router renders the new URL;
  // external navigation (including Back) is authoritative on the next render.
  const latest = useRef({ source: params, value: params });
  if (latest.current.source !== params) latest.current = { source: params, value: params };

  function update(action, todayKey = clock.todayKey) {
    latest.current.value = calendarViewParams(latest.current.value, action, todayKey);
    setParams(latest.current.value, { replace: true });
  }

  return {
    ...clock, ...calendarViewState(params, clock.todayKey),
    changeMonth(date, offset) {
      update({ type: 'month', month: monthKey(date), offset });
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
