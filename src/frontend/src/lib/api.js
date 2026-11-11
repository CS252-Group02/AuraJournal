export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';
let epoch = 0;
export function changeAuthEpoch() { epoch += 1; }
export function getAuthEpoch() { return epoch; }

export async function api(path, { method = 'GET', body, signal, idempotencyKey } = {}) {
  const started = epoch;
  const response = await fetch(`${API_URL}${path}`, {
    method, credentials: 'include', signal,
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
