import { useSyncExternalStore } from 'react';
import { DEFAULT_PREFERENCES, readPreferences, subscribePreferences, updatePreferences } from './preferences.js';

const serverSnapshot = () => DEFAULT_PREFERENCES;

export function usePreferences() {
  const preferences = useSyncExternalStore(subscribePreferences, readPreferences, serverSnapshot);
  return [preferences, updatePreferences];
}
