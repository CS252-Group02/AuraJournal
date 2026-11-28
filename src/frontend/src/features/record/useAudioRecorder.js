import { useEffect, useState, useSyncExternalStore } from 'react';
import { createAudioRecorder } from './audioRecorder.js';
import { microphoneConstraints } from '../settings/preferences.js';

export function useAudioRecorder() {
  const [recorder] = useState(() => createAudioRecorder({ audioConstraints: microphoneConstraints }));
  const state = useSyncExternalStore(recorder.subscribe, recorder.getSnapshot);
  useEffect(() => () => recorder.reset(), [recorder]);
  return { ...state, recorder };
}
