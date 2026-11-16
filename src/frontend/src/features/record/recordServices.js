import { api, API_URL, getAuthEpoch } from '../../lib/api.js';
import { createTranscriptionSession } from './transcriptionSession.js';

// Set paths only after the backend deploys and verifies the proposed protocol.
// Missing contracts are intentionally unavailable; no mock is used by the app.
const transcriptionPath = import.meta.env.VITE_RECORD_TRANSCRIPTION_PATH || '';
const proofreadPath = import.meta.env.VITE_RECORD_PROOFREAD_PATH || '';
const idempotentSaveAvailable = import.meta.env.VITE_RECORD_IDEMPOTENT_SAVE === 'true';
function backendUrl(path) {
  if (!path.startsWith('/api/') || path.includes('?') || path.includes('#')) throw new Error('Invalid Record backend path.');
  return `${API_URL}${path}`;
}

export const recordServices = {
  transcriptionAvailable: Boolean(transcriptionPath),
  proofreadAvailable: Boolean(proofreadPath),
  idempotentSaveAvailable,
  getAuthEpoch,
  unauthorized() { window.dispatchEvent(new Event('aurajournal:unauthorized')); },
  createSession(callbacks) {
    const session = createTranscriptionSession({ ...callbacks, url: backendUrl(transcriptionPath).replace(/^http/, 'ws') });
    return { ...session, async open() {
      try { return await session.open(); }
      catch (failure) {
        // A rejected browser WS handshake does not expose its HTTP status.
        // Distinguish an expired account from an ordinary connection failure.
        if (failure.name !== 'AbortError') {
          try { await api('/api/auth/me'); }
          catch (error) { if (error.status === 401) recordServices.unauthorized(); }
        }
        throw failure;
      }
    } };
  },
  proofread(content, { signal }) {
    backendUrl(proofreadPath);
    return api(proofreadPath, { method: 'POST', body: { content }, signal });
  },
  save(content, { signal, idempotencyKey }) {
    return api('/api/entries', { method: 'POST', body: { content }, signal,
      ...(idempotentSaveAvailable ? { idempotencyKey } : {}) });
  },
};
