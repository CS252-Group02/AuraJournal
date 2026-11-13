import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { parseDateKey, toDateKey } from '../../lib/localDate.js';
import { monthKey, parseMonthKey } from './calendarModel.js';

function readClock() {
  return { todayKey: toDateKey(new Date()), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' };
}

export function useCalendarView() {
  const [params, setParams] = useSearchParams();
  const [clock, setClock] = useState(readClock);

  useEffect(() => {
    let timer;
    function refresh() {
      window.clearTimeout(timer);
      const next = readClock();
      setClock(previous => previous.todayKey === next.todayKey && previous.timezone === next.timezone ? previous : next);
      const now = new Date();
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      timer = window.setTimeout(refresh, midnight.getTime() - now.getTime() + 50);
    }
    function visible() { if (document.visibilityState === 'visible') refresh(); }
    refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);

  const today = parseDateKey(clock.todayKey);
  const month = parseMonthKey(params.get('month')) || new Date(today.getFullYear(), today.getMonth(), 1);
  const requestedDate = parseDateKey(params.get('date'));
  const selectedKey = requestedDate && monthKey(requestedDate) === monthKey(month) ? toDateKey(requestedDate) : null;
  const mode = params.get('mode') === 'heatmap' ? 'heatmap' : 'mood';

  function update(values) {
    setParams(previous => {
      const next = new URLSearchParams(previous);
      for (const [key, value] of Object.entries(values)) {
        if (value == null) next.delete(key);
        else next.set(key, value);
      }
      return next;
    }, { replace: true });
  }

  return {
    ...clock, today, month, selectedKey, mode,
    changeMonth(date) {
      update({ month: monthKey(date), date: selectedKey?.startsWith(`${monthKey(date)}-`) ? selectedKey : null });
    },
    selectDate(key) { update({ month: monthKey(month), date: key }); },
    changeMode(value) { update({ month: monthKey(month), mode: value }); },
    goToday() {
      const current = readClock();
      setClock(current);
      update({ month: current.todayKey.slice(0, 7), date: current.todayKey });
    },
  };
}
