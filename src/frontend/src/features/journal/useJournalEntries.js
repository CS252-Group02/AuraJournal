import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../lib/api.js';

export function useJournalEntries() {
  const [entries, setEntries] = useState([]);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const request = useRef(0);

  const load = useCallback(async () => {
    const current = ++request.current;
    setStatus('loading');
    setError('');
    try {
      const result = await api('/api/entries');
      if (current !== request.current) return;
      setEntries(result);
      setStatus('ready');
    } catch (failure) {
      if (current !== request.current) return;
      setError(failure.status ? failure.message : 'Could not connect to AuraJournal. Check your connection and try again.');
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    load();
    return () => { request.current += 1; };
  }, [load]);

  return { entries, setEntries, status, error, reload: load };
}
