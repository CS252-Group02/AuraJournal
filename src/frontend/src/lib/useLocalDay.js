import { useCallback, useEffect, useState } from 'react';
import { toDateKey } from './localDate.js';

export function readLocalDay() {
  return { todayKey: toDateKey(new Date()), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' };
}

// Shared calendar clock: local midnight, focus, and timezone changes use one policy.
export function useLocalDay() {
  const [clock, setClock] = useState(readLocalDay);
  const refresh = useCallback(() => {
    const next = readLocalDay();
    setClock(previous => previous.todayKey === next.todayKey && previous.timezone === next.timezone ? previous : next);
    return next;
  }, []);
  useEffect(() => {
    let timer;
    function update() {
      window.clearTimeout(timer);
      refresh();
      const now = new Date();
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      timer = window.setTimeout(update, midnight.getTime() - now.getTime() + 50);
    }
    function visible() { if (document.visibilityState === 'visible') update(); }
    update();
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refresh]);
  return { ...clock, refresh };
}
