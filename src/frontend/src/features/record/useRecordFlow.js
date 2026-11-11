import { useEffect, useState, useSyncExternalStore } from 'react';
import { useAudioRecorder } from './useAudioRecorder.js';
import { createRecordFlow } from './recordFlow.js';
import { recordServices } from './recordServices.js';

export function useRecordFlow(services = recordServices) {
  const { recorder } = useAudioRecorder();
  const [adapters] = useState(() => services);
  const [flow] = useState(() => createRecordFlow({ recorder, services: adapters }));
  const state = useSyncExternalStore(flow.subscribe, flow.getSnapshot);
  useEffect(() => flow.connect(), [flow]);
  useEffect(() => {
    if (!['review', 'saving', 'proofreading'].includes(state.phase)) return;
    const warn = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [state.phase]);
  return { ...state, flow, capabilities: adapters };
}
