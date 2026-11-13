import { useEffect, useState, useSyncExternalStore } from 'react';
import { useAudioRecorder } from './useAudioRecorder.js';
import { createRecordFlow } from './recordFlow.js';
import { recordServices } from './recordServices.js';

export function useRecordFlow(services = recordServices) {
  const { recorder } = useAudioRecorder();
  const [adapters] = useState(() => services);
  const [flow] = useState(() => createRecordFlow({ recorder, services: adapters }));
  const state = useSyncExternalStore(flow.subscribe, flow.getSnapshot);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const hasUnsavedWork = state.phase !== 'saved' && (
    ['connecting', 'recording', 'finalizing', 'proofreading', 'saving'].includes(state.phase) ||
    Boolean(state.capture.blob || state.editorText || state.saveUnknown) ||
    Object.keys(state.transcript.segments).length > 0
  );
  useEffect(() => flow.connect(), [flow]);
  useEffect(() => {
    if (state.capture.status !== 'recording') return;
    const started = performance.now();
    setElapsedSeconds(0);
    const update = () => setElapsedSeconds(Math.floor((performance.now() - started) / 1000));
    const timer = window.setInterval(update, 1000);
    return () => { window.clearInterval(timer); update(); };
  }, [state.capture.status]);
  useEffect(() => { if (state.phase === 'ready') setElapsedSeconds(0); }, [state.phase]);
  useEffect(() => {
    if (!hasUnsavedWork) return;
    const warn = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasUnsavedWork]);
  return { ...state, flow, capabilities: adapters, elapsedSeconds, hasUnsavedWork };
}
