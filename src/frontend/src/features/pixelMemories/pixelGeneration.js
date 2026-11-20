import { api, getAuthEpoch, subscribeAuthChanges } from '../../lib/api.js';
import { validMemoryImage } from './pixelMemoriesModel.js';

export const PIXEL_GENERATION_TIMEOUT = 180000;

function imagePath(entryId) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(entryId)) throw new Error('Invalid journal ID.');
  return `/api/entries/${entryId}/pixel-art`;
}

function validatedResult(result, entryId) {
  if (result?.entry_id !== entryId || !validMemoryImage(result)) throw new Error('Invalid image generation response.');
  return result;
}

export async function generatePixelMemory(entryId, { signal } = {}) {
  return validatedResult(await api(imagePath(entryId), { method: 'POST', body: {}, signal }), entryId);
}

export async function checkPixelMemory(entryId, { signal } = {}) {
  try { return validatedResult(await api(imagePath(entryId), { signal }), entryId); }
  catch (error) { if (error.status === 404) return null; throw error; }
}

const UNCERTAIN = 'Generation completion is uncertain. Check for a saved image before retrying. A retry may incur another charge.';

export function pixelGenerationError(error) {
  switch (error?.status) {
    case 401: return 'Your session expired. Please sign in again.';
    case 403: return 'Generation was blocked by a security check. Check your session before trying again.';
    case 404: return 'This journal is no longer available. Refresh memories to update your journals.';
    case 409: return 'Another generation is running, or this journal changed. Refresh memories and check for a saved image before retrying.';
    case 422: return 'This journal could not be used to generate an image. Review its content before trying again.';
    case 429: return 'Image generation is busy. Wait a moment before choosing Generate again.';
    case 502: return 'The image service returned invalid output. Your journal is unchanged.';
    case 503: return 'Image generation is unavailable. The service may be disabled or out of credits. Try again later.';
    default: return UNCERTAIN;
  }
}

export function generationBlocked(state) {
  return ['generating', 'checking', 'uncertain', 'missing', 'expired'].includes(state?.status);
}

// One explicit submission at a time, shared across every day in the gallery.
// An uncertain result must be checked with GET before a new billable retry.
export function createPixelGeneration({ onChange, onSaved, request = generatePixelMemory,
  check = checkPixelMemory, subscribe = subscribeAuthChanges, getEpoch = getAuthEpoch }) {
  let version = 0, controller, unsubscribe, busy = false, state = { status: 'idle' };
  const publish = next => { state = next; onChange(next); };
  function cancel() {
    version++;
    controller?.abort();
    unsubscribe?.();
    controller = unsubscribe = undefined;
    busy = false;
    state = { status: 'idle' };
  }
  async function run(entryId, scope, checking) {
    cancel();
    busy = true;
    const current = version, epoch = getEpoch(), pending = new AbortController();
    controller = pending;
    unsubscribe = subscribe(() => { cancel(); publish({ scope, status: 'expired' }); });
    const active = () => current === version && epoch === getEpoch();
    const timer = setTimeout(() => pending.abort(Object.assign(new Error('Request timed out.'), { status: 504 })),
      checking ? 30000 : PIXEL_GENERATION_TIMEOUT);
    let aborted;
    const interrupted = new Promise((resolve, reject) => {
      aborted = () => reject(pending.signal.reason);
      pending.signal.addEventListener('abort', aborted, { once: true });
    });
    publish({ scope, entryId, status: checking ? 'checking' : 'generating' });
    let saved;
    try {
      const result = await Promise.race([(checking ? check : request)(entryId, { signal: pending.signal }), interrupted]);
      if (!active() || pending.signal.aborted) return;
      if (checking && result === null) publish({ scope, entryId, status: 'missing',
        message: 'No saved image was found yet. The previous request may still finish. Retrying may incur another charge.' });
      else {
        validatedResult(result, entryId);
        saved = result;
        publish({ scope, entryId, status: 'saved', representation: result.representation });
      }
    } catch (error) {
      if (!active()) return;
      const uncertain = checking || !error.status || [409, 504].includes(error.status);
      publish({ scope, entryId, status: error.status === 401 ? 'expired' : uncertain ? 'uncertain' : 'error',
        message: checking ? 'Could not check for a saved image. No new generation was sent. Try checking again.' : pixelGenerationError(error) });
    } finally {
      clearTimeout(timer);
      pending.signal.removeEventListener('abort', aborted);
      if (current === version) { busy = false; controller = undefined; }
    }
    // Reading journals/metadata after a confirmed save is separate from POST.
    // A failed refresh must never offer another generation as its recovery.
    if (saved && active()) onSaved(saved);
  }
  return {
    cancel,
    generate(entryId, scope) {
      if (busy || generationBlocked(state) || (state.status === 'saved' && state.entryId === entryId)) return;
      return run(entryId, scope, false);
    },
    checkSaved() {
      if (busy || !['uncertain', 'missing'].includes(state.status)) return;
      return run(state.entryId, state.scope, true);
    },
    retry() {
      if (busy || state.status !== 'missing') return;
      return run(state.entryId, state.scope, false);
    },
  };
}
