import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { createRecapLoader } from '../reflection/reflectionApi.js';

export function fetchDashboardReflection(start, timezone, { signal } = {}) {
  return api('/api/reflections/weekly', { method: 'POST', body: { start, timezone, date_basis: 'journal' }, signal });
}

export function useDashboardReflection({ scope, startKey, timezone, enabled }) {
  const [state, setState] = useState({ status: 'idle' });
  const [loader] = useState(() => createRecapLoader({ request: fetchDashboardReflection, onChange: setState }));
  useEffect(() => {
    loader.cancel();
    setState({ key: scope, status: 'idle' });
    return () => loader.cancel();
  }, [loader, scope, enabled]);
  return {
    state: enabled && state.key === scope ? state : { status: 'idle' },
    generate() { if (enabled) loader.run(scope, startKey, timezone); },
  };
}
