export const PREFERENCES_KEY = 'aurajournal-preferences';

export const DEFAULT_PREFERENCES = Object.freeze({
  motion: 'system',
  startWith: 'voice',
  microphone: '',
  proofread: true,
  showQuote: true,
  showStreak: true,
});

const CHOICES = { motion: ['system', 'reduced'], startWith: ['voice', 'writing'] };
const SWITCHES = ['proofread', 'showQuote', 'showStreak'];
const listeners = new Set();
let cached = null;

export function normalizePreferences(value) {
  const source = value && typeof value === 'object' ? value : {};
  const result = { ...DEFAULT_PREFERENCES };
  for (const [key, options] of Object.entries(CHOICES)) {
    if (options.includes(source[key])) result[key] = source[key];
  }
  for (const key of SWITCHES) {
    if (typeof source[key] === 'boolean') result[key] = source[key];
  }
  if (typeof source.microphone === 'string' && source.microphone.length <= 512) result.microphone = source.microphone;
  return Object.freeze(result);
}

export function readPreferences() {
  if (cached) return cached;
  try { cached = normalizePreferences(JSON.parse(globalThis.localStorage.getItem(PREFERENCES_KEY) || 'null')); }
  catch { cached = normalizePreferences(null); }
  return cached;
}

export function applyMotion(motion = readPreferences().motion) {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  if (motion === 'reduced') root.dataset.motion = 'reduced';
  else delete root.dataset.motion;
}

export function updatePreferences(changes) {
  cached = normalizePreferences({ ...readPreferences(), ...changes });
  try { globalThis.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(cached)); }
  catch {}
  applyMotion(cached.motion);
  listeners.forEach(listener => listener());
  return cached;
}

export function subscribePreferences(listener) {
  listeners.add(listener);
  function sync(event) {
    if (event.key !== PREFERENCES_KEY && event.key !== null) return;
    cached = null;
    applyMotion();
    listener();
  }
  globalThis.addEventListener?.('storage', sync);
  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener?.('storage', sync);
  };
}

export function microphoneConstraints() {
  const id = readPreferences().microphone;
  return id ? { deviceId: id } : true;
}

export function resetPreferenceCache() {
  cached = null;
}
