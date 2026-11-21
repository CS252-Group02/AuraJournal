import { api, apiPng, getAuthEpoch, subscribeAuthChanges } from '../../lib/api.js';
import { hasPendingMemories, memoryDates, validateMemoryFeed, validateMemoryJournals } from './pixelMemoriesModel.js';

export const MEMORY_POLL_INTERVAL = 5000;
export const MEMORY_POLL_WINDOW = 120000;

export async function fetchMemoryFeed(asOf, { signal } = {}) {
  memoryDates(asOf);
  return validateMemoryFeed(await api(`/api/entries/pixel-art/memories?as_of=${encodeURIComponent(asOf)}`,
    { signal, cache: 'no-store' }), asOf);
}

export async function fetchMemoryJournals({ signal, asOf } = {}) {
  const dates = memoryDates(asOf);
  return validateMemoryJournals(await api(`/api/entries?start=${dates[0]}&end=${asOf}`, { signal, cache: 'no-store' }));
}

export function pixelMemoryError(error) {
  switch (error?.status) {
    case 401: return 'Your session expired. Please sign in again.';
    case 403: return 'Access was blocked. Check your session and try again.';
    case 404: return 'This image is no longer available. Refresh memories to check for journal changes.';
    case 429: return 'Image requests are busy. Wait a moment before trying again.';
    case 503: return 'Pixel memories are temporarily unavailable. Please try again later.';
    case 504: return 'The image request timed out. Please try again.';
    default: return 'Couldn’t load pixel memories. Check your connection and try again.';
  }
}

// Only reads. A polling window belongs to one date range and auth epoch.
// Unchanged feeds reuse the snapshot and never repeat the journal-list request.
export function createMemoriesLoader({ onChange, request = fetchMemoryFeed, requestEntries = fetchMemoryJournals,
  subscribe = subscribeAuthChanges, getEpoch = getAuthEpoch, visibility = globalThis.document,
  focus = globalThis.window, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let version = 0, sequence = 0, controller, pollTimer, requestTimer, windowTimer, unsubscribe;
  let asOf, epoch, expires = 0, data = null, fingerprint = null, watching = false, running = false;
  const visible = () => visibility?.visibilityState !== 'hidden';
  const publish = (status, extra = {}) => onChange({ asOf, status, data, refreshing: false, windowExpired: false, ...extra });
  function abortRead() {
    sequence++;
    controller?.abort(); controller = undefined;
    clearTimer(requestTimer); clearTimer(pollTimer);
  }
  function pause() {
    abortRead(); clearTimer(windowTimer);
    if (running) publish(data ? 'ready' : 'loading');
  }
  function cancel() {
    running = false; version++; pause();
    unsubscribe?.(); unsubscribe = undefined;
    if (watching) {
      visibility?.removeEventListener('visibilitychange', visibilityChanged);
      focus?.removeEventListener('focus', focused);
      watching = false;
    }
  }
  function expireWindow() {
    abortRead();
    publish(data ? 'ready' : 'error', { windowExpired: Boolean(data && hasPendingMemories(data.feed, asOf)) });
  }
  async function read(forceEntries = false) {
    if (!running || !visible() || epoch !== getEpoch()) return;
    abortRead();
    const current = version, requestId = sequence, pending = new AbortController();
    controller = pending;
    const active = () => running && current === version && requestId === sequence &&
      !pending.signal.aborted && epoch === getEpoch() && visible();
    publish(data ? 'ready' : 'loading', { refreshing: Boolean(data) });
    requestTimer = setTimer(() => {
      if (!active()) return;
      abortRead();
      clearTimer(windowTimer);
      publish('error', { error: 'The memory request timed out. Please try again.' });
    }, 30000);
    try {
      const feed = validateMemoryFeed(await request(asOf, { signal: pending.signal }), asOf);
      if (!active()) return;
      const nextFingerprint = JSON.stringify(feed);
      let entries = data?.entries;
      if (forceEntries || !entries || nextFingerprint !== fingerprint) {
        entries = validateMemoryJournals(await requestEntries({ signal: pending.signal, asOf }));
      }
      if (!active()) return;
      if (!data || nextFingerprint !== fingerprint || forceEntries) data = { feed, entries };
      fingerprint = nextFingerprint;
      publish('ready');
      if (hasPendingMemories(feed, asOf)) {
        if (now() + MEMORY_POLL_INTERVAL < expires) pollTimer = setTimer(() => read(), MEMORY_POLL_INTERVAL);
        else publish('ready', { windowExpired: true });
      } else clearTimer(windowTimer);
    } catch (error) {
      if (active()) {
        clearTimer(windowTimer);
        if (error?.status === 401) { cancel(); data = null; publish('expired'); }
        else publish('error', { error: pixelMemoryError(error) });
      }
    } finally {
      if (current === version && requestId === sequence) {
        clearTimer(requestTimer); controller = undefined;
      }
    }
  }
  function refresh() {
    if (!running || !visible() || epoch !== getEpoch()) return;
    abortRead(); clearTimer(windowTimer);
    expires = now() + MEMORY_POLL_WINDOW;
    windowTimer = setTimer(expireWindow, MEMORY_POLL_WINDOW);
    return read(true);
  }
  function focused() { if (visible()) refresh(); }
  function visibilityChanged() { if (visible()) refresh(); else pause(); }
  function load(value) {
    cancel(); memoryDates(value);
    asOf = value; epoch = getEpoch(); data = null; fingerprint = null; running = true;
    unsubscribe = subscribe(() => { cancel(); data = null; publish('expired'); });
    visibility?.addEventListener('visibilitychange', visibilityChanged);
    focus?.addEventListener('focus', focused); watching = true;
    if (!visible()) { publish('loading'); return Promise.resolve(); }
    return refresh();
  }
  return { load, refresh, cancel };
}

// One visible thumbnail owns one object URL. Keep the auth subscription after
// loading so logout also revokes images that have already finished rendering.
export function createMemoryImageLoader({ onChange, request = apiPng,
  createURL = blob => URL.createObjectURL(blob), revokeURL = url => URL.revokeObjectURL(url),
  subscribe = subscribeAuthChanges, getEpoch = getAuthEpoch }) {
  let version = 0, controller, unsubscribe, url;
  function release() { if (url) { revokeURL(url); url = undefined; } }
  function cancel() {
    version++;
    controller?.abort();
    unsubscribe?.();
    controller = unsubscribe = undefined;
    release();
  }
  function unavailable(presentedURL) {
    if (presentedURL && presentedURL !== url) return;
    release();
    onChange({ status: 'error', error: 'This image could not be displayed. Try loading it again or open its journal.' });
  }
  async function load(path) {
    cancel();
    const current = version, epoch = getEpoch(), pending = new AbortController();
    controller = pending;
    unsubscribe = subscribe(() => { cancel(); onChange({ status: 'expired' }); });
    const active = () => current === version && !pending.signal.aborted && epoch === getEpoch();
    onChange({ status: 'loading' });
    try {
      const blob = await request(path, { signal: pending.signal });
      if (!active()) return;
      url = createURL(blob);
      onChange({ status: 'ready', url });
    } catch (error) {
      if (active()) onChange({ status: 'error', error: pixelMemoryError(error) });
    }
  }
  return { load, cancel, unavailable };
}
