import { useSearchParams } from 'react-router-dom';
import { parseDateKey, toDateKey } from '../../lib/localDate.js';
import { useLocalDay } from '../../lib/useLocalDay.js';
import { monthKey, parseMonthKey } from './calendarModel.js';

export function useCalendarView() {
  const [params, setParams] = useSearchParams();
  const { refresh, ...clock } = useLocalDay();

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
    selectDate(key) {
      if (parseDateKey(key)) update({ month: key.slice(0, 7), date: key });
    },
    changeMode(value) { update({ month: monthKey(month), mode: value }); },
    goToday() {
      const current = refresh();
      update({ month: current.todayKey.slice(0, 7), date: current.todayKey });
    },
  };
}
