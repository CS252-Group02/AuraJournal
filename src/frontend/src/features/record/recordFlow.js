import { createTranscript, mergeSegment, transcriptText, validContent } from './transcriptState.js';
import { AUDIO_UPLOAD_TIMEOUT, recordingUploadError, validUploadedTranscript } from './audioUpload.js';

const initial = () => ({ phase: 'ready', transcript: createTranscript(), originalTranscript: '',
  unconfirmedText: '', proposedDraft: '', editorText: '', editRevision: 0,
  incomplete: false, error: '', warning: '', savedEntry: null, saveUnknown: false,
  uploadOffered: false, uploadStatus: 'idle', uploadTranscript: null, uploadRetryable: true });

// Feature orchestration, independent of React, layout and concrete network adapters.
export function createRecordFlow({ recorder, services, schedule = setTimeout, cancel = clearTimeout,
  proofreadTimeout = 30000, saveTimeout = 15000, uploadTimeout = AUDIO_UPLOAD_TIMEOUT,
  makeKey = () => globalThis.crypto.randomUUID(),
}) {
  let state = initial(), snapshot = { ...state, capture: recorder.getSnapshot(), transcriptionActive: false };
  let generation = 0, authEpoch, attached = false, transport = null, transportFailed = false;
  let unsubscribeChunks, pendingAbort, startupTask, stopTask, saveAttempt;
  let localRecording = false, uploadGeneration = 0;
  const listeners = new Set();
  const current = (token) => attached && token === generation && authEpoch === services.getAuthEpoch();
  function publish(value = {}) {
    state = { ...state, ...value };
    const capture = recorder.getSnapshot();
    snapshot = { ...state, capture, transcriptionActive: Boolean(transport && !transportFailed),
      uploadAfterStop: Boolean(localRecording && services.uploadAvailable),
      canUpload: state.phase === 'review' && state.uploadOffered && state.uploadRetryable &&
        !state.saveUnknown && !['succeeded', 'session_changed'].includes(state.uploadStatus) &&
        !recordingUploadError(capture.blob) && current(generation) };
    listeners.forEach(listener => listener());
  }
  function disconnect() {
    unsubscribeChunks?.(); unsubscribeChunks = null;
    transport?.close(); transport = null;
  }
  function reset() {
    ++generation;
    ++uploadGeneration;
    pendingAbort?.abort(); pendingAbort = null;
    disconnect(); startupTask = null; stopTask = null; saveAttempt = null; transportFailed = false; localRecording = false;
    recorder.reset();
    publish(initial());
  }
  async function request(task, timeout) {
    const controller = new AbortController();
    pendingAbort = controller;
    let timer, onAbort, timedOut = false;
    const interrupted = new Promise((resolve, reject) => {
      onAbort = () => reject(new DOMException(timedOut ? 'Request timed out.' : 'Request cancelled.', timedOut ? 'TimeoutError' : 'AbortError'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
      timer = schedule(() => { timedOut = true; controller.abort(); }, timeout);
    });
    try { return await Promise.race([task(controller.signal), interrupted]); }
    finally {
      cancel(timer); controller.signal.removeEventListener('abort', onAbort);
      if (pendingAbort === controller) pendingAbort = null;
    }
  }
  function segment(event, token) {
    if (!current(token) || !['connecting', 'recording', 'finalizing'].includes(state.phase)) return;
    publish({ transcript: mergeSegment(state.transcript, event) });
  }
  function streamFailure(error, token) {
    if (!current(token) || transportFailed || !['connecting', 'recording', 'finalizing'].includes(state.phase)) return;
    transportFailed = true;
    transport?.close();
    publish({ warning: error.message || 'Live transcription failed. Your audio is still recorded locally.' });
    if (error.code === 'unauthorized' || error.code === 'auth_expired') services.unauthorized?.();
  }
  async function start({ localOnly = false } = {}) {
    if (!attached || !['ready', 'error'].includes(state.phase) || recorder.getSnapshot().blob) return;
    const token = ++generation;
    authEpoch = services.getAuthEpoch(); transportFailed = false; startupTask = null; saveAttempt = null;
    publish({ ...initial(), phase: 'connecting' });
    const live = services.transcriptionAvailable && !localOnly;
    localRecording = !live;
    try {
      let negotiation;
      if (live) {
        transport = services.createSession({ onSegment: event => segment(event, token), onFailure: error => streamFailure(error, token) });
        negotiation = await transport.open();
        if (!current(token)) return;
        unsubscribeChunks = recorder.subscribeToChunks(blob => {
          if (!current(token) || transportFailed) return;
          try { transport?.push(blob); } catch (error) { streamFailure(error, token); }
        });
      }
      if (!current(token)) return;
      await recorder.start({ allowedMimeTypes: negotiation?.acceptedMimeTypes });
      if (!current(token)) return;
      if (recorder.getSnapshot().status !== 'recording') throw new Error(recorder.getSnapshot().error || 'Recording could not start.');
      // Install the handshake task before publishing a phase that permits Stop.
      // Chunks (including an immediate Stop's tail) remain queued until started.
      if (live && !transportFailed) {
        startupTask = (async () => {
          try { await transport.start(recorder.getSnapshot().mimeType); }
          catch (error) { streamFailure(error, token); }
        })();
      }
      const startup = startupTask;
      publish({ phase: 'recording', warning: live ? state.warning : services.uploadAvailable
        ? 'Recording locally. After Stop, supported audio will be uploaded for transcription. You can review and edit before saving.'
        : 'Live transcription is unavailable. Record locally, then write or correct your journal below.' });
      await startup;
    } catch (error) {
      if (!current(token)) return;
      disconnect();
      publish({ phase: 'error', error: error.message || 'Recording could not start. Please try again.' });
    }
  }
  function enterReview({ warning = '', incomplete = state.incomplete } = {}) {
    const text = transcriptText(state.transcript);
    publish({ phase: 'review', originalTranscript: text.finalizedTranscript,
      unconfirmedText: incomplete ? text.interimTranscript : '', editorText: text.finalizedTranscript,
      editRevision: state.editRevision + 1, incomplete, warning, error: '' });
  }
  async function finalize(token, capture) {
    if (!current(token) || capture.cancelled) return;
    let complete = false;
    if (transport && !transportFailed) {
      try {
        const result = await transport.finish();
        if (!current(token)) return;
        const text = transcriptText(state.transcript);
        if (result.final_count !== text.finalCount) throw new Error('Some final transcription results are missing.');
        const interim = Boolean(text.interimTranscript.trim());
        if (!['transcribed', 'no_speech', 'incomplete'].includes(result.outcome) ||
            (result.outcome === 'transcribed' && (!text.finalCount || interim)) ||
            (result.outcome === 'no_speech' && (text.finalCount || interim)) ||
            (result.outcome === 'incomplete' && !interim)) throw new Error('The transcription completion does not match the received text. Review your audio before saving.');
        complete = !capture.error && result.outcome !== 'incomplete';
        if (!complete && !capture.error) publish({ warning: 'The last phrase was not confirmed. Review it against your audio before saving.' });
      } catch (error) {
        if (!current(token)) return;
        publish({ warning: error.message || 'The final transcript is incomplete.' });
      }
    }
    disconnect();
    if (!current(token)) return;
    const text = transcriptText(state.transcript).finalizedTranscript;
    publish({ originalTranscript: text, incomplete: !complete });
    if (!complete) {
      enterReview({ incomplete: true, warning: [capture.error, state.warning].filter(Boolean).join(' ') || 'Transcription is incomplete. Listen to your recording and review the text manually.' });
      if (services.uploadAvailable && capture.blob) {
        const invalid = recordingUploadError(capture.blob);
        publish({ uploadOffered: true, ...(invalid ? { uploadStatus: 'unavailable', uploadRetryable: false, error: invalid } : {}) });
        // A live attempt may already be billable, even without confirmed text.
        // Only a purely local take starts HTTP automatically, once.
        if (localRecording && !capture.error && !invalid) await transcribe();
      }
      return;
    }
    if (!validContent(text)) {
      enterReview({ warning: text.trim() ? 'The transcript exceeds 5000 characters. Shorten it before saving; nothing has been removed.' : 'No speech was confirmed. Listen to your recording and enter text, or reset.' });
      return;
    }
    if (!services.proofreadAvailable) {
      enterReview({ warning: 'AI proofreading is unavailable. Review and edit the original transcript before saving.' });
      return;
    }
    const revision = state.editRevision;
    publish({ phase: 'proofreading', error: '', warning: '' });
    try {
      const result = await request(signal => services.proofread(text, { signal }), proofreadTimeout);
      if (!current(token) || state.phase !== 'proofreading' || state.editRevision !== revision) return;
      if (!validContent(result?.proofread_content)) throw new Error('Invalid proofreading result.');
      publish({ phase: 'review', proposedDraft: result.proofread_content, editorText: result.proofread_content });
    } catch {
      if (current(token) && state.phase === 'proofreading') enterReview({ warning: 'Proofreading could not finish. Your original transcript is ready for manual review.' });
    }
  }
  function stop() {
    if (state.phase === 'finalizing') return stopTask;
    if (state.phase !== 'recording') return Promise.resolve();
    const token = generation;
    const startup = startupTask;
    publish({ phase: 'finalizing', error: '' });
    stopTask = (async () => {
      const capture = await recorder.stop(); // Includes the final dataavailable event.
      await startup; // Release the microphone first; finish only after started.
      await finalize(token, capture);
    })();
    return stopTask;
  }
  async function transcribe() {
    const capture = recorder.getSnapshot();
    if (!attached || state.phase !== 'review' || !state.uploadOffered || !services.uploadAvailable ||
        !state.uploadRetryable || state.saveUnknown || state.uploadStatus === 'succeeded' || !current(generation)) return;
    const invalid = recordingUploadError(capture.blob);
    if (invalid) { publish({ error: invalid, uploadStatus: 'unavailable', uploadRetryable: false }); return; }
    const token = generation, attempt = ++uploadGeneration, revision = state.editRevision;
    const existingText = Boolean(state.originalTranscript || state.editorText);
    // Lock before starting the request, so repeated clicks cannot upload twice.
    publish({ phase: 'transcribing', uploadStatus: 'pending', error: '', warning: '' });
    try {
      const result = await request(signal => services.uploadAudio(capture.blob, { signal }), uploadTimeout);
      if (!current(token) || attempt !== uploadGeneration || state.phase !== 'transcribing') return;
      if (!validUploadedTranscript(result)) throw new Error('The server returned an invalid transcript. Your recording is kept; you can try again.');
      const warning = result.outcome === 'no_speech'
        ? 'No speech was recognized. Listen to your recording and write or correct your journal manually.'
        : 'Review the transcript against your recording before saving.';
      if (existingText || state.editRevision !== revision) {
        publish({ phase: 'review', uploadStatus: 'succeeded',
          uploadTranscript: result.outcome === 'transcribed' ? result.transcript : null,
          warning: result.outcome === 'transcribed'
            ? 'The full recording was transcribed. Your existing text is kept. Compare the uploaded transcript below before choosing to replace your draft.' : warning });
      } else {
        publish({ phase: 'review', uploadStatus: 'succeeded', originalTranscript: result.transcript,
          editorText: result.transcript, editRevision: state.editRevision + 1,
          unconfirmedText: '', incomplete: false, warning });
      }
    } catch (error) {
      if (!current(token) || attempt !== uploadGeneration || state.phase !== 'transcribing') return;
      publish({ phase: 'review', uploadStatus: 'failed', uploadRetryable: error.retryable !== false,
        error: error.name === 'TimeoutError'
          ? 'Transcription took too long and was cancelled. Your recording and draft are kept. Retry when ready, or write your journal manually.'
          : error.message || 'Transcription failed. Your recording and draft are kept; retry when ready.' });
    }
  }
  function cancelUpload({ sessionChanged = false } = {}) {
    if (state.phase !== 'transcribing') return;
    ++uploadGeneration;
    pendingAbort?.abort();
    publish({ phase: 'review', uploadStatus: sessionChanged ? 'session_changed' : 'cancelled',
      error: '', warning: sessionChanged
        ? 'Your session changed. Transcription was cancelled. This take cannot be submitted in a different session. Discard it to start a new take.'
        : 'Transcription cancelled. Your recording and draft are kept. You can retry or review manually.' });
  }
  async function save() {
    if (!attached || state.phase !== 'review' || !validContent(state.editorText) ||
        (state.saveUnknown && !services.idempotentSaveAvailable)) return;
    const token = generation, text = state.editorText;
    if (!current(token)) return;
    if (!saveAttempt || (!state.saveUnknown && saveAttempt.content !== text)) saveAttempt = { content: text, key: makeKey() };
    const attempt = saveAttempt;
    // Publish synchronously: a second click cannot get past this lock.
    publish({ phase: 'saving', error: '' });
    try {
      const result = await request(signal => services.save(attempt.content, { signal, idempotencyKey: attempt.key }), saveTimeout);
      if (!current(token)) return;
      if (typeof result?.id !== 'string' || result.content !== attempt.content.trim()) throw new Error('Invalid save response.');
      publish({ phase: 'saved', savedEntry: result, saveUnknown: false, warning: '', error: '' });
      recorder.reset(); // Release audio after confirmed save; retain the reviewed text.
    } catch (error) {
      if (!current(token)) return;
      const unknown = !error.status || error.status === 408 || error.status >= 500;
      publish({ phase: 'review', saveUnknown: unknown, error: unknown
        ? 'The save result is unknown. Your journal may already exist. Keep this draft and check your journals before creating another entry.'
        : error.message || 'Saving failed. Your draft has been kept.' });
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    connect() {
      attached = true;
      const unsubscribe = recorder.subscribe(() => {
        publish();
        if (state.phase === 'recording' && ['stopped', 'error'].includes(recorder.getSnapshot().status)) void stop();
      });
      const unsubscribeAuth = services.subscribeAuthChanges?.(() => cancelUpload({ sessionChanged: true }));
      publish();
      return () => { attached = false; unsubscribe(); unsubscribeAuth?.(); reset(); };
    },
    start, stop, reset, save, transcribe, cancelUpload: () => cancelUpload(),
    useUploadTranscript() {
      if (state.phase !== 'review' || state.saveUnknown || state.uploadTranscript === null || !current(generation)) return;
      publish({ editorText: state.uploadTranscript, editRevision: state.editRevision + 1,
        incomplete: false, error: '', warning: 'Review the uploaded transcript and make any corrections before saving.' });
    },
    edit(text) {
      if (!['review', 'transcribing'].includes(state.phase) || state.saveUnknown) return;
      publish({ editorText: text, editRevision: state.editRevision + 1, error: '' });
    },
    useOriginal() {
      if (state.phase !== 'proofreading') return;
      pendingAbort?.abort();
      enterReview({ warning: 'Reviewing the original transcript. No AI response will replace your edits.' });
    },
  };
}
