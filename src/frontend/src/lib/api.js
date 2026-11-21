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
  const response = await fetch(`${API_URL}${path}`, {
    method, credentials: 'include', signal, ...(cache ? { cache } : {}),
    headers: { 'Content-Type': 'application/json', 'X-AuraJournal-CSRF': '1',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (started !== epoch) throw new Error('Session changed.');
  const result = response.status === 204 ? null : await response.json();
  if (started !== epoch) throw new Error('Session changed.');
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/auth/login' && path !== '/api/auth/me') {
      window.dispatchEvent(new Event('aurajournal:unauthorized'));
    }
    const detail = result?.detail;
    const error = new Error(Array.isArray(detail)
      ? detail.map((item) => `${item.loc.at(-1)}: ${item.msg}`).join(' ')
      : detail || 'The request failed. Please try again.');
    error.status = response.status;
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
