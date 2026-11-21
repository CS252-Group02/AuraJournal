import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../lib/api.js';

export function useJournalEntries(path = '/api/entries') {
  const [entries, setEntries] = useState([]);
  const [status, setStatus] = useState(path ? 'loading' : 'idle');
  const [error, setError] = useState('');
  const request = useRef(0);

  const load = useCallback(async () => {
    const current = ++request.current;
    if (!path) {
      setEntries([]);
      setStatus('idle');
      setError('');
      return;
    }
    setStatus('loading');
    setError('');
    try {
      const result = await api(path);
      if (current !== request.current) return;
      setEntries(result);
      setStatus('ready');
    } catch (failure) {
      if (current !== request.current) return;
      setError(failure.status ? failure.message : 'Could not connect to AuraJournal. Check your connection and try again.');
      setStatus('error');
    }
  }, [path]);

  useEffect(() => {
    load();
    return () => { request.current += 1; };
  }, [load]);

  return { entries, setEntries, status, error, reload: load };
}
