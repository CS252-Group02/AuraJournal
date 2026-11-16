import { useEffect, useState, useSyncExternalStore } from 'react';
import { createAudioRecorder } from './audioRecorder.js';

export function useAudioRecorder() {
  const [recorder] = useState(createAudioRecorder);
  const state = useSyncExternalStore(recorder.subscribe, recorder.getSnapshot);
  useEffect(() => () => recorder.reset(), [recorder]);
  return { ...state, recorder };
}
