import { createTranscript, mergeSegment, transcriptText, validContent } from './transcriptState.js';

const initial = () => ({ phase: 'ready', transcript: createTranscript(), originalTranscript: '',
  unconfirmedText: '', proposedDraft: '', editorText: '', editRevision: 0,
  incomplete: false, error: '', warning: '', savedEntry: null, saveUnknown: false });

// Feature orchestration, independent of React, layout and concrete network adapters.
export function createRecordFlow({ recorder, services, schedule = setTimeout, cancel = clearTimeout,
  proofreadTimeout = 30000, saveTimeout = 15000, makeKey = () => globalThis.crypto.randomUUID(),
}) {
  let state = initial(), snapshot = { ...state, capture: recorder.getSnapshot(), transcriptionActive: false };
  let generation = 0, authEpoch, attached = false, transport = null, transportFailed = false;
  let unsubscribeChunks, pendingAbort, stopTask, saveAttempt;
  const listeners = new Set();
  const current = (token) => attached && token === generation && authEpoch === services.getAuthEpoch();
  function publish(value = {}) {
    state = { ...state, ...value };
    snapshot = { ...state, capture: recorder.getSnapshot(), transcriptionActive: Boolean(transport && !transportFailed) };
    listeners.forEach(listener => listener());
  }
  function disconnect() {
    unsubscribeChunks?.(); unsubscribeChunks = null;
    transport?.close(); transport = null;
  }
  function reset() {
    ++generation;
    pendingAbort?.abort(); pendingAbort = null;
    disconnect(); stopTask = null; saveAttempt = null; transportFailed = false;
    recorder.reset();
    publish(initial());
  }
  async function request(task, timeout) {
    const controller = new AbortController();
    pendingAbort = controller;
    let timer, onAbort;
    const interrupted = new Promise((resolve, reject) => {
      onAbort = () => reject(new DOMException('Request cancelled.', 'AbortError'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
      timer = schedule(() => controller.abort(), timeout);
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
    if (!current(token) || !['connecting', 'recording', 'finalizing'].includes(state.phase)) return;
    transportFailed = true;
    publish({ warning: error.message || 'Live transcription failed. Your audio is still recorded locally.' });
    if (error.code === 'unauthorized' || error.code === 'auth_expired') services.unauthorized?.();
  }
  async function start({ localOnly = false } = {}) {
    if (!attached || !['ready', 'error'].includes(state.phase) || recorder.getSnapshot().blob) return;
    const token = ++generation;
    authEpoch = services.getAuthEpoch(); transportFailed = false; saveAttempt = null;
    publish({ ...initial(), phase: 'connecting' });
    const live = services.transcriptionAvailable && !localOnly;
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
      publish({ phase: 'recording', warning: live ? state.warning : 'Live transcription is unavailable. Record locally, then write or correct your journal below.' });
      if (live) {
        try { await transport.start(recorder.getSnapshot().mimeType); }
        catch (error) { streamFailure(error, token); }
      }
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
        if (result.final_count !== transcriptText(state.transcript).finalCount) throw new Error('Some final transcription results are missing.');
        complete = !capture.error && !transcriptText(state.transcript).interimTranscript.trim();
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
      enterReview({ incomplete: true, warning: capture.error || state.warning || 'Transcription is incomplete. Listen to your recording and review the text manually.' });
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
    publish({ phase: 'finalizing', error: '' });
    stopTask = (async () => {
      const capture = await recorder.stop(); // Includes the final dataavailable event.
      await finalize(token, capture);
    })();
    return stopTask;
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
      publish();
      return () => { attached = false; unsubscribe(); reset(); };
    },
    start, stop, reset, save,
    edit(text) {
      if (state.phase !== 'review' || state.saveUnknown) return;
      publish({ editorText: text, editRevision: state.editRevision + 1, error: '' });
    },
    useOriginal() {
      if (state.phase !== 'proofreading') return;
      pendingAbort?.abort();
      enterReview({ warning: 'Reviewing the original transcript. No AI response will replace your edits.' });
    },
  };
}
