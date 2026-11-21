import { api, apiPng, getAuthEpoch, subscribeAuthChanges } from '../../lib/api.js';
import { memoryDates } from './pixelMemoriesModel.js';

export async function fetchRecentMemories(asOf, { signal } = {}) {
  memoryDates(asOf);
  const records = await api(`/api/entries/pixel-art/recent?as_of=${encodeURIComponent(asOf)}`, { signal });
  if (!Array.isArray(records)) throw new Error('Invalid pixel memory metadata.');
  return records;
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

export function createMemoriesLoader({ onChange, request = fetchRecentMemories,
  subscribe = subscribeAuthChanges, getEpoch = getAuthEpoch }) {
  let version = 0, controller, unsubscribe, timer;
  function cancel() {
    version++;
    controller?.abort();
    clearTimeout(timer);
    unsubscribe?.();
    controller = unsubscribe = undefined;
  }
  async function load(asOf) {
    cancel();
    const current = version, epoch = getEpoch(), pending = new AbortController();
    controller = pending;
    unsubscribe = subscribe(() => { cancel(); onChange({ status: 'expired' }); });
    timer = setTimeout(() => {
      cancel();
      onChange({ status: 'error', error: 'The memory request timed out. Please try again.' });
    }, 30000);
    const active = () => current === version && !pending.signal.aborted && epoch === getEpoch();
    onChange({ status: 'loading' });
    try {
      const records = await request(asOf, { signal: pending.signal });
      if (active()) onChange({ status: 'ready', records });
    } catch (error) {
      if (active()) onChange({ status: 'error', error: pixelMemoryError(error) });
    } finally {
      if (current === version) clearTimeout(timer);
    }
  }
  return { load, cancel };
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
