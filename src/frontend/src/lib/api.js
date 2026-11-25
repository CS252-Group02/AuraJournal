export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';
let epoch = 0;
const authListeners = new Set();
export function changeAuthEpoch() {
  epoch += 1;
  authListeners.forEach(listener => listener());
}
export function getAuthEpoch() { return epoch; }
export function subscribeAuthChanges(listener) {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

export async function api(path, { method = 'GET', body, signal, idempotencyKey, cache } = {}) {
  const started = epoch;
  function check() {
    signal?.throwIfAborted();
    if (started !== epoch) throw new Error('Session changed.');
  }
  check();
  let response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method, credentials: 'include', signal, ...(cache ? { cache } : {}),
      headers: { 'Content-Type': 'application/json', 'X-AuraJournal-CSRF': '1',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    check();
    throw new Error('Could not connect to AuraJournal. Check your connection and try again.');
  }
  check();
  let result = null;
  try { result = response.status === 204 ? null : await response.json(); }
  catch {
    check();
    if (response.ok) throw Object.assign(new Error('The server returned an invalid response. Please try again.'), { status: 502 });
  }
  check();
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/auth/login' && path !== '/api/auth/me') {
      window.dispatchEvent(new Event('aurajournal:unauthorized'));
    }
    const detail = result?.detail;
    const messages = {
      401: 'Your session expired. Please log in again.',
      429: 'Too many requests. Wait a moment and try again.',
      502: 'The service returned an invalid response. Please try again.',
      503: 'The service is unavailable. Please try again later.',
      504: 'The request timed out. Please try again later.',
    };
    const validation = Array.isArray(detail) && detail.length > 0 && detail.every(item =>
      Array.isArray(item?.loc) && typeof item.msg === 'string');
    const message = (path === '/api/auth/login' && response.status === 401 && typeof detail === 'string' ? detail : messages[response.status])
      || (response.status < 500 && (validation
        ? detail.map(item => `${item.loc.at(-1)}: ${item.msg}`).join(' ')
        : typeof detail === 'string' && detail))
      || 'The request failed. Please try again.';
    const error = new Error(message);
    error.status = response.status;
    const seconds = response.headers?.get('Retry-After');
    if (response.status === 429 && /^\d{1,6}$/.test(seconds || '')) error.retryAfter = Number(seconds);
    throw error;
  }
  return result;
}

// Private PNGs are binary responses, not JSON or public <img> URLs. Accept only
// canonical application content paths; never follow a backend-supplied redirect.
export async function apiPng(path, { signal } = {}) {
  if (!/^\/api\/entries\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/pixel-art\/content$/.test(path)) {
    throw new Error('Invalid pixel image path.');
  }
  const started = epoch;
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  const unsubscribe = subscribeAuthChanges(() => controller.abort(new Error('Session changed.')));
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new Error('Image request timed out. Please retry.')), 30000);
  function check() {
    controller.signal.throwIfAborted();
    if (started !== epoch) throw new Error('Session changed.');
  }
  try {
    check();
    const response = await fetch(`${API_URL}${path}`, {
      credentials: 'include', signal: controller.signal, cache: 'no-store',
      redirect: 'error', headers: { Accept: 'image/png' },
    });
    check();
    if (!response.ok) {
      if (response.status === 401) window.dispatchEvent(new Event('aurajournal:unauthorized'));
      throw Object.assign(new Error('Could not load the private pixel image.'), { status: response.status });
    }
    if (response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'image/png') {
      throw new Error('The server did not return a PNG image.');
    }
    const blob = await response.blob();
    check();
    if (!blob.size || blob.size > 2 * 1024 * 1024) throw new Error('Invalid pixel image size.');
    const signature = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
    check();
    if (![137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => signature[i] === value)) {
      throw new Error('Invalid PNG image.');
    }
    return blob;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    unsubscribe();
  }
}
