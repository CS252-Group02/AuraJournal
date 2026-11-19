export const AUDIO_UPLOAD_MIME = 'audio/webm;codecs=opus';
export const MAX_AUDIO_UPLOAD_BYTES = 10 * 1024 * 1024;
// Backend: 30s to read audio + 60s recognition, with room for bounded cleanup.
export const AUDIO_UPLOAD_TIMEOUT = 100000;

export function recordingUploadError(blob) {
  if (!(blob instanceof Blob) || !blob.size) return 'No audio was captured. Check your microphone and record again, or write your journal manually.';
  if (!/^audio\/webm\s*;\s*codecs\s*=\s*(?:opus|"opus")\s*$/i.test(blob.type)) {
    return 'This recording format cannot be uploaded. Use a browser that records WebM/Opus, or listen and write your journal manually.';
  }
  if (blob.size > MAX_AUDIO_UPLOAD_BYTES) return 'This recording exceeds the 10 MiB upload limit. Record a shorter take, or listen and write your journal manually.';
  return '';
}

const messages = new Map([
  [400, 'The audio upload was interrupted or invalid. Your recording is kept; you can try again.'],
  [401, 'Your session expired. Your recording and draft are kept here. Restore your session before retrying, or review manually.'],
  [403, 'The upload was blocked by a security check. Check the frontend origin and session configuration before retrying.'],
  [413, 'This recording exceeds the server upload limit. Listen and write your journal manually, or record a shorter take.'],
  [415, 'The server does not accept this recording format. Listen and write your journal manually, or record WebM/Opus in a supported browser.'],
  [422, 'This audio is empty, invalid, or could not be decoded. Listen and write your journal manually, or record again.'],
  [429, 'Transcription is busy or your request limit was reached. Wait before choosing Retry transcription.'],
  [502, 'The speech service returned an incomplete or invalid transcript. Your recording is kept; you can try again.'],
  [503, 'The speech service is unavailable. Your recording is kept; try again later.'],
  [504, 'Transcription timed out. Your recording is kept; you can retry or write your journal manually.'],
]);

export function validUploadedTranscript(result) {
  return typeof result?.transcript === 'string' && (
    (result.outcome === 'transcribed' && Boolean(result.transcript.trim())) ||
    (result.outcome === 'no_speech' && result.transcript === '')
  );
}

// A raw-Blob adapter alongside the JSON API helper. One call makes one request;
// callers own deadlines and user-initiated retries. No provider details are shown.
export function createAudioUpload({ apiUrl, getAuthEpoch, subscribeAuthChanges,
  fetch: send = (...args) => globalThis.fetch(...args) }) {
  return async function uploadAudio(blob, { signal } = {}) {
    const invalid = recordingUploadError(blob);
    if (invalid) throw Object.assign(new Error(invalid), { retryable: false });
    const epoch = getAuthEpoch();
    const controller = new AbortController();
    const sessionError = () => Object.assign(new Error('Your session changed. The previous transcription cannot be used in this session.'), { code: 'session_changed' });
    const abort = () => controller.abort(signal.reason);
    const unsubscribe = subscribeAuthChanges?.(() => controller.abort(sessionError()));
    let onAbort;
    const interrupted = new Promise((resolve, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    const check = () => {
      controller.signal.throwIfAborted();
      if (epoch !== getAuthEpoch()) throw sessionError();
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      return await Promise.race([interrupted, (async () => {
        check();
        let response;
        try {
          response = await send(`${apiUrl}/api/transcriptions`, {
            method: 'POST', credentials: 'include', signal: controller.signal,
            headers: { 'Content-Type': AUDIO_UPLOAD_MIME, 'X-AuraJournal-CSRF': '1' },
            body: blob,
          });
        } catch (error) {
          check();
          throw Object.assign(new Error('The audio upload could not reach the server. Check your connection, then retry. Your recording is kept.'), { cause: error });
        }
        check();
        if (!response.ok) {
          const seconds = response.headers?.get('Retry-After');
          const wait = response.status === 429 && /^\d{1,6}$/.test(seconds || '')
            ? ` Try again in ${Number(seconds)} seconds.` : '';
          throw Object.assign(new Error((messages.get(response.status) || 'Transcription failed. Your recording is kept; try again later.') + wait), {
            status: response.status, retryable: ![413, 415, 422].includes(response.status),
          });
        }
        let result;
        try { result = await response.json(); }
        catch { check(); throw new Error('The server returned an invalid transcript. Your recording is kept; you can try again.'); }
        check();
        if (!validUploadedTranscript(result)) throw new Error('The server returned an invalid transcript. Your recording is kept; you can try again.');
        return result; // Preserve all whitespace, Unicode and punctuation exactly.
      })()]);
    } finally {
      signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', onAbort);
      unsubscribe?.();
    }
  };
}
