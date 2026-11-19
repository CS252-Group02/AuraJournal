import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecordFlow } from '../src/frontend/src/features/record/recordFlow.js';
import { createAudioRecorder } from '../src/frontend/src/features/record/audioRecorder.js';
import { createTranscript, mergeSegment, transcriptSegments, transcriptText, contentLength, validContent } from '../src/frontend/src/features/record/transcriptState.js';
import { createTranscriptionSession } from '../src/frontend/src/features/record/transcriptionSession.js';
import { AUDIO_UPLOAD_TIMEOUT, createAudioUpload } from '../src/frontend/src/features/record/audioUpload.js';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const result = (id, order, text, is_final = true, revision = 0) => ({ segment_id: id, order, revision, text, is_final });

function fixture(overrides = {}) {
  const track = Object.assign(new EventTarget(), { readyState: 'live', stop() { this.readyState = 'ended'; }, getSettings: () => ({ sampleRate: 48000 }) });
  let mediaRequests = 0, device, callbacks, segmentCount = 0, epoch = 0, keys = 0;
  const sent = [], proofreads = [], saves = [], revoked = [], order = [], uploads = [], authListeners = new Set();
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  class Recorder extends EventTarget {
    static isTypeSupported(type) { return type === (overrides.mimeType || 'audio/webm;codecs=opus'); }
    constructor(input, options) { super(); device = this; this.mimeType = options.mimeType; this.state = 'inactive'; }
    start() { this.state = 'recording'; }
    chunk(value) { this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: new Blob([value], { type: this.mimeType }) })); }
    stop() { this.state = 'inactive'; queueMicrotask(() => { this.chunk('last-audio'); this.dispatchEvent(new Event('stop')); }); }
  }
  const recorder = createAudioRecorder({
    mediaDevices: { getUserMedia: async () => {
      mediaRequests++;
      if (overrides.mediaError?.()) throw new DOMException('Capture failed', 'NotAllowedError');
      track.readyState = 'live';
      return stream;
    } }, MediaRecorder: Recorder,
    urls: { createObjectURL: () => 'blob:test-take', revokeObjectURL: url => revoked.push(url) },
  });
  const session = {
    open: async () => ({ acceptedMimeTypes: ['audio/webm;codecs=opus'] }),
    start: async () => {}, push: blob => { sent.push(blob); order.push('audio'); },
    finish: async () => {
      order.push('finish');
      return { final_count: segmentCount, outcome: transcriptText(flow.getSnapshot().transcript).interimTranscript.trim()
        ? 'incomplete' : segmentCount ? 'transcribed' : 'no_speech' };
    }, close() {},
    ...overrides.session,
  };
  const services = {
    transcriptionAvailable: true, proofreadAvailable: true, idempotentSaveAvailable: true,
    getAuthEpoch: () => epoch,
    subscribeAuthChanges(listener) { authListeners.add(listener); return () => authListeners.delete(listener); },
    createSession: handlers => { callbacks = handlers; return session; },
    proofread: async (content, options) => { proofreads.push({ content, options }); return { proofread_content: `${content}.` }; },
    save: async (content, options) => { saves.push({ content, options }); return { id: 'entry-1', content: content.trim() }; },
    ...overrides.services,
    uploadAudio(blob, options) {
      uploads.push({ blob, options });
      return overrides.services?.uploadAudio?.(blob, options) ?? Promise.resolve({ transcript: 'Hôm nay I feel happy.', outcome: 'transcribed' });
    },
  };
  const flow = createRecordFlow({ recorder, services, makeKey: () => `key-${++keys}`, ...overrides.flow });
  const cleanup = flow.connect();
  return { flow, recorder, track, sent, proofreads, saves, revoked, order, cleanup, uploads,
    get mediaRequests() { return mediaRequests; }, get device() { return device; },
    emit(event) { callbacks.onSegment(event); segmentCount = transcriptText(flow.getSnapshot().transcript).finalCount; },
    failure(error) { callbacks.onFailure(error); }, changeAccount() { epoch++; authListeners.forEach(listener => listener()); },
  };
}

test('interim replacement, revisions, ordered finals and real repeated phrases do not duplicate', () => {
  let state = createTranscript();
  state = mergeSegment(state, result('one', 0, 'Hôm', false));
  state = mergeSegment(state, result('one', 0, 'Hôm nay', false, 1));
  assert.equal(transcriptText(state).interimTranscript, 'Hôm nay');
  state = mergeSegment(state, result('one', 0, 'old', false));
  state = mergeSegment(state, result('two', 1, 'Nguyễn Minh Anh')); // Arrives ahead of the first final.
  state = mergeSegment(state, result('one', 0, 'Hôm nay', true, 2));
  state = mergeSegment(state, result('two', 1, 'duplicate final', true, 5));
  state = mergeSegment(state, result('three', 2, 'Nguyễn Minh Anh'));
  assert.deepEqual(transcriptText(state), { finalizedTranscript: 'Hôm nay Nguyễn Minh Anh Nguyễn Minh Anh', interimTranscript: '', finalCount: 3 });
  assert.throws(() => mergeSegment(state, result('conflict', 2, 'bad')), /conflicting/);
  assert.throws(() => mergeSegment(state, { text: 'bad' }), /invalid/);
});

test('Unicode validation counts code points and retains over-limit content for manual correction', () => {
  assert.equal(contentLength('😀'), 1);
  assert.ok(validContent('😀'.repeat(5000)));
  assert.ok(!validContent(' '.repeat(10)));
  assert.ok(!validContent('a'.repeat(5001)));
});

test('segment selection preserves text output through partial finals, retractions and late segments', () => {
  let state = createTranscript();
  const apply = event => { state = mergeSegment(state, event); return transcriptSegments(state); };
  const draft = result('a', 0, 'Hôm nay tôi đọc sách', false);
  assert.equal(apply(draft).interim.text, draft.text);
  apply(result('a', 0, ' Hôm nay ', true, 1));
  const suffix = result('b', 1, 'tôi đọc sách', false);
  assert.equal(apply(suffix).interim.text, suffix.text);
  assert.deepEqual(transcriptText(state), { finalizedTranscript: 'Hôm nay', interimTranscript: suffix.text, finalCount: 1 });
  apply(result('b', 1, '', false, 1));
  assert.equal(transcriptText(state).interimTranscript, '');
  apply(result('c', 2, ' Đọc sách. ', true));
  assert.equal(transcriptSegments(state).interim, undefined);
  assert.equal(transcriptText(state).finalizedTranscript, 'Hôm nay Đọc sách.');
  assert.equal(apply(result('b', 1, 'stale interim', false, 2)).interim, undefined);
});

test('Stop sends final audio, waits for final results, proofreads once, then saves current edited text explicitly', async () => {
  const completion = deferred();
  const f = fixture({ session: { finish: () => { f.order.push('finish'); return completion.promise; } } });
  await f.flow.start();
  f.device.chunk('first-header');
  f.emit(result('a', 0, 'Hôm nay tôi gặp Nguyễn Minh Anh', false));
  const stopping = f.flow.stop();
  await tick();
  assert.equal(f.flow.getSnapshot().phase, 'finalizing');
  assert.equal(f.proofreads.length, 0);
  assert.equal(f.track.readyState, 'ended');
  assert.equal(await new Blob(f.sent).text(), 'first-headerlast-audio');
  assert.equal(f.order.at(-1), 'finish');
  f.emit(result('a', 0, 'Hôm nay tôi gặp Nguyễn Minh Anh', true, 1));
  f.emit(result('b', 1, 'và chúng tôi cùng ôn bài'));
  completion.resolve({ final_count: 2, outcome: 'transcribed' }); await stopping;
  assert.equal(f.flow.getSnapshot().phase, 'review');
  assert.equal(f.proofreads.length, 1);
  assert.equal(f.saves.length, 0);
  assert.match(f.flow.getSnapshot().editorText, /ôn bài\.$/);
  const original = f.flow.getSnapshot().originalTranscript;
  f.flow.edit(f.flow.getSnapshot().editorText.replace('ôn', 'học'));
  await f.flow.save(); await f.flow.save();
  assert.equal(f.saves.length, 1);
  assert.match(f.saves[0].content, /học bài\.$/);
  assert.equal(f.flow.getSnapshot().originalTranscript, original);
  assert.equal(f.flow.getSnapshot().phase, 'saved');
  assert.equal(f.mediaRequests, 1);
  assert.deepEqual(f.revoked, ['blob:test-take']);
  f.cleanup();
});

test('empty, long and unavailable proofreading results open manual review without creating a journal', async () => {
  for (const text of ['', 'x'.repeat(5001), 'Original']) {
    const f = fixture({ services: { proofreadAvailable: text !== 'Original' } });
    await f.flow.start();
    if (text) f.emit(result('a', 0, text));
    await f.flow.stop();
    assert.equal(f.flow.getSnapshot().phase, 'review');
    assert.equal(f.flow.getSnapshot().editorText, text);
    assert.equal(f.proofreads.length, 0);
    assert.equal(f.saves.length, 0);
    assert.ok(f.flow.getSnapshot().capture.url);
    f.cleanup();
  }
});

test('a late AI response cannot replace a bypassed/edited draft', async () => {
  const ai = deferred();
  const f = fixture({ services: { proofread: () => ai.promise } });
  await f.flow.start(); f.emit(result('a', 0, 'Original'));
  const stopping = f.flow.stop(); await tick();
  assert.equal(f.flow.getSnapshot().phase, 'proofreading');
  f.flow.useOriginal(); f.flow.edit('My corrected words');
  ai.resolve({ proofread_content: 'Late AI text' }); await stopping;
  assert.equal(f.flow.getSnapshot().editorText, 'My corrected words');
  f.emit(result('late', 1, 'Late transcript'));
  assert.equal(f.flow.getSnapshot().originalTranscript, 'Original');
  f.cleanup();
});

test('proofreading failures, invalid output and timeouts preserve original and audio', async () => {
  for (const proofread of [async () => { throw new Error('offline'); }, async () => ({ proofread_content: '' }), () => new Promise(() => {})]) {
    const f = fixture({ services: { proofread }, flow: { proofreadTimeout: 2 } });
    await f.flow.start(); f.emit(result('a', 0, 'Tiếng Việt'));
    await f.flow.stop();
    assert.equal(f.flow.getSnapshot().phase, 'review');
    assert.equal(f.flow.getSnapshot().editorText, 'Tiếng Việt');
    assert.ok(f.flow.getSnapshot().capture.url);
    f.cleanup();
  }
});

test('disconnect/finalization failure preserves confirmed text and unconfirmed phrase, without AI', async () => {
  const f = fixture();
  await f.flow.start(); f.emit(result('a', 0, 'Confirmed'));
  f.emit(result('b', 1, 'Not confirmed', false));
  f.failure(new Error('Disconnected'));
  assert.equal(f.flow.getSnapshot().transcriptionActive, false);
  assert.equal(f.track.readyState, 'live');
  await f.flow.stop();
  assert.equal(f.flow.getSnapshot().editorText, 'Confirmed');
  assert.equal(f.flow.getSnapshot().unconfirmedText, 'Not confirmed');
  assert.equal(f.flow.getSnapshot().incomplete, true);
  assert.equal(f.proofreads.length, 0);
  f.cleanup();
});

test('missing final segments and completion timeout fall back to review', async () => {
  for (const finish of [async () => ({ final_count: 99, outcome: 'transcribed' }), async () => { throw new Error('Final results timed out'); }]) {
    const f = fixture({ session: { finish } });
    await f.flow.start(); f.emit(result('a', 0, 'Kept'));
    await f.flow.stop();
    assert.equal(f.flow.getSnapshot().editorText, 'Kept');
    assert.equal(f.flow.getSnapshot().incomplete, true);
    assert.equal(f.proofreads.length, 0);
    f.cleanup();
  }
});

test('a completion that leaves an interim phrase is incomplete, not a confirmed original', async () => {
  const f = fixture();
  await f.flow.start(); f.emit(result('a', 0, 'Confirmed'));
  f.emit(result('b', 1, 'Unconfirmed tail', false));
  await f.flow.stop();
  assert.equal(f.flow.getSnapshot().incomplete, true);
  assert.equal(f.flow.getSnapshot().originalTranscript, 'Confirmed');
  assert.equal(f.flow.getSnapshot().unconfirmedText, 'Unconfirmed tail');
  assert.equal(f.proofreads.length, 0);
  f.cleanup();
});

test('save timeout and an invalid save response preserve the draft as an uncertain outcome', async () => {
  for (const save of [() => new Promise(() => {}), async () => ({ id: 'wrong', content: 'Not the draft' })]) {
    const f = fixture({ services: { save }, flow: { saveTimeout: 2 } });
    await f.flow.start(); f.emit(result('a', 0, 'Original')); await f.flow.stop();
    await f.flow.save();
    assert.equal(f.flow.getSnapshot().saveUnknown, true);
    assert.equal(f.flow.getSnapshot().editorText, 'Original.');
    assert.ok(f.flow.getSnapshot().capture.url);
    f.cleanup();
  }
});

test('connection failures never request a microphone and have a genuine local-only recovery', async () => {
  const f = fixture({ session: { open: async () => { throw new Error('Cannot connect'); } } });
  await f.flow.start();
  assert.equal(f.mediaRequests, 0);
  assert.equal(f.flow.getSnapshot().phase, 'error');
  await f.flow.start({ localOnly: true });
  assert.equal(f.mediaRequests, 1);
  await f.flow.stop();
  assert.equal(f.flow.getSnapshot().phase, 'review');
  f.cleanup();
});

test('normal app fallback records locally and permits manual review/save without mock transcription', async () => {
  const f = fixture({ services: { transcriptionAvailable: false, proofreadAvailable: false } });
  await f.flow.start(); await f.flow.stop();
  assert.equal(f.flow.getSnapshot().editorText, '');
  await f.flow.save(); assert.equal(f.saves.length, 0);
  f.flow.edit('User wrote this'); await f.flow.save();
  assert.equal(f.saves[0].content, 'User wrote this');
  assert.equal(f.proofreads.length, 0);
  f.cleanup();
});

test('save is synchronously locked and definitive validation failure preserves editable draft/audio', async () => {
  const saving = deferred(); let calls = 0;
  const f = fixture({ services: { save: () => { calls++; return saving.promise; } } });
  await f.flow.start(); f.emit(result('a', 0, 'Original')); await f.flow.stop();
  const pending = f.flow.save(); await f.flow.save(); f.flow.edit('Must not replace in-flight payload');
  assert.equal(calls, 1);
  saving.reject(Object.assign(new Error('Invalid content'), { status: 422 })); await pending;
  assert.equal(f.flow.getSnapshot().phase, 'review');
  assert.equal(f.flow.getSnapshot().saveUnknown, false);
  assert.ok(f.flow.getSnapshot().capture.url);
  f.flow.edit('Corrected'); assert.equal(f.flow.getSnapshot().editorText, 'Corrected');
  f.cleanup();
});

test('lost save response retries the same payload/key and never creates a second entry', async () => {
  const database = new Map(), requests = [];
  const f = fixture({ services: { save: async (content, { idempotencyKey }) => {
    requests.push({ content, idempotencyKey });
    if (!database.has(idempotencyKey)) {
      database.set(idempotencyKey, { id: 'created-once', content }); throw new Error('Response lost after commit');
    }
    return database.get(idempotencyKey);
  } } });
  await f.flow.start(); f.emit(result('a', 0, 'Draft')); await f.flow.stop();
  await f.flow.save();
  assert.equal(f.flow.getSnapshot().saveUnknown, true);
  f.flow.edit('Not allowed while uncertain');
  await f.flow.save();
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(database.size, 1);
  assert.equal(f.flow.getSnapshot().phase, 'saved');
  f.cleanup();
});

test('uncertain save cannot retry without verified server idempotency', async () => {
  let calls = 0;
  const f = fixture({ services: { idempotentSaveAvailable: false, save: async () => { calls++; throw new Error('unknown'); } } });
  await f.flow.start(); f.emit(result('a', 0, 'Draft')); await f.flow.stop();
  await f.flow.save(); await f.flow.save();
  assert.equal(calls, 1);
  assert.equal(f.flow.getSnapshot().saveUnknown, true);
  assert.ok(f.flow.getSnapshot().capture.blob);
  f.cleanup();
});

test('Reset, unmount, account change and late responses cannot update another take', async () => {
  const ai = deferred();
  const f = fixture({ services: { proofread: () => ai.promise } });
  await f.flow.start(); f.emit(result('a', 0, 'Private'));
  const stopping = f.flow.stop(); await tick();
  f.flow.reset(); ai.resolve({ proofread_content: 'Late private text' }); await stopping;
  assert.equal(f.flow.getSnapshot().editorText, '');
  assert.equal(f.flow.getSnapshot().phase, 'ready');
  f.cleanup();
  const other = fixture();
  await other.flow.start(); other.changeAccount(); other.emit(result('a', 0, 'Previous account'));
  assert.equal(transcriptText(other.flow.getSnapshot().transcript).finalizedTranscript, '');
  other.cleanup(); assert.equal(other.track.readyState, 'ended');
});

test('permission denial can retry the same existing flow, then stop and transcribe', async () => {
  let denied = true;
  const f = fixture({ mediaError: () => denied, services: { transcriptionAvailable: false, uploadAvailable: true } });
  await f.flow.start();
  assert.equal(f.flow.getSnapshot().phase, 'error');
  assert.match(f.flow.getSnapshot().error, /access was denied/);
  denied = false;
  await f.flow.start();
  assert.equal(f.flow.getSnapshot().phase, 'recording');
  await f.flow.stop();
  assert.equal(f.flow.getSnapshot().phase, 'review');
  assert.equal(f.uploads.length, 1);
  assert.equal(f.mediaRequests, 2);
  f.cleanup();
});

test('the existing local recovery after a failed live connection uploads once after Stop', async () => {
  const f = fixture({ services: { uploadAvailable: true }, session: { open: async () => { throw new Error('Live unavailable'); } } });
  await f.flow.start();
  assert.equal(f.flow.getSnapshot().phase, 'error');
  assert.equal(f.mediaRequests, 0);
  assert.equal(f.uploads.length, 0);
  await f.flow.start({ localOnly: true });
  assert.equal(f.flow.getSnapshot().uploadAfterStop, true);
  await f.flow.stop();
  assert.equal(f.uploads.length, 1);
  assert.equal(f.flow.getSnapshot().editorText, 'Hôm nay I feel happy.');
  assert.equal(f.mediaRequests, 1);
  f.cleanup();
});

test('completed local recording reaches the HTTP adapter as raw WebM bytes and enters review exactly', async () => {
  const calls = [], transcript = '  Hôm nay\nI feel happy. 😀  ';
  const uploadAudio = createAudioUpload({ apiUrl: 'http://api.test', getAuthEpoch: () => 0,
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      return new Response(JSON.stringify({ transcript, outcome: 'transcribed' }));
    },
  });
  const f = fixture({ services: { transcriptionAvailable: false, uploadAvailable: true, uploadAudio } });
  await f.flow.start();
  f.device.chunk(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])); f.device.chunk('audio-body');
  await f.flow.stop();
  const state = f.flow.getSnapshot(), call = calls[0];
  assert.equal(state.phase, 'review');
  assert.equal(state.editorText, transcript);
  assert.equal(state.originalTranscript, transcript);
  assert.equal(state.incomplete, false);
  assert.equal(state.uploadStatus, 'succeeded');
  assert.equal(call.body, state.capture.blob);
  assert.equal(call.headers['Content-Type'], 'audio/webm;codecs=opus');
  assert.equal(call.headers['X-AuraJournal-CSRF'], '1');
  assert.equal(call.credentials, 'include');
  assert.equal(await call.body.slice(4).text(), 'audio-bodylast-audio');
  assert.deepEqual(new Uint8Array(await call.body.slice(0, 4).arrayBuffer()), new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]));
  assert.ok(state.capture.url);
  assert.equal(f.track.readyState, 'ended');
  assert.equal(f.mediaRequests, 1);
  assert.equal(f.proofreads.length, 0);
  assert.equal(f.saves.length, 0);
  await f.flow.transcribe(); assert.equal(calls.length, 1);
  f.flow.edit('My reviewed correction'); await f.flow.save();
  assert.equal(f.saves[0].content, 'My reviewed correction');
  assert.equal(calls.length, 1);
  assert.equal(f.flow.getSnapshot().phase, 'saved');
  f.cleanup();
});

test('slow HTTP transcription shows processing, retains playback, locks submission and honors the deadline', async () => {
  const timers = new Map(), delays = [];
  const f = fixture({ services: { transcriptionAvailable: false, uploadAvailable: true, uploadAudio: () => new Promise(() => {}) },
    flow: { schedule: (callback, delay) => { delays.push(delay); timers.set(delay, callback); return delay; }, cancel: id => timers.delete(id) } });
  await f.flow.start(); const stopping = f.flow.stop(); await tick();
  assert.equal(f.flow.getSnapshot().phase, 'transcribing');
  assert.ok(f.flow.getSnapshot().capture.url);
  assert.ok(f.flow.getSnapshot().capture.blob);
  assert.deepEqual(delays, [AUDIO_UPLOAD_TIMEOUT]);
  f.flow.edit('Draft while waiting');
  await f.flow.transcribe(); await f.flow.save();
  assert.equal(f.uploads.length, 1);
  assert.equal(f.saves.length, 0);
  timers.get(AUDIO_UPLOAD_TIMEOUT)(); await stopping;
  assert.equal(f.flow.getSnapshot().phase, 'review');
  assert.match(f.flow.getSnapshot().error, /took too long/);
  assert.equal(f.flow.getSnapshot().editorText, 'Draft while waiting');
  assert.equal(f.uploads[0].options.signal.aborted, true);
  assert.ok(f.flow.getSnapshot().canUpload);
  assert.ok(f.flow.getSnapshot().capture.url);
  assert.equal(timers.size, 0);
  f.cleanup();
});

test('HTTP no_speech enters manual review, retains playback and never saves or proofreads automatically', async () => {
  const f = fixture({ services: { transcriptionAvailable: false, uploadAvailable: true,
    uploadAudio: async () => ({ transcript: '', outcome: 'no_speech' }) } });
  await f.flow.start(); await f.flow.stop();
  const state = f.flow.getSnapshot();
  assert.equal(state.phase, 'review');
  assert.equal(state.editorText, '');
  assert.equal(state.incomplete, false);
  assert.match(state.warning, /No speech was recognized/);
  assert.ok(state.capture.url);
  assert.equal(f.proofreads.length, 0);
  await f.flow.save(); assert.equal(f.saves.length, 0);
  f.flow.edit('Written after listening'); await f.flow.save();
  assert.equal(f.saves[0].content, 'Written after listening');
  f.cleanup();
});

test('HTTP failures preserve the same Blob and edits; only explicit retry makes one new request', async () => {
  for (const status of [undefined, 401, 403, 413, 415, 422, 429, 502, 503, 504]) {
    const retry = deferred(); let calls = 0;
    const f = fixture({ services: { transcriptionAvailable: false, uploadAvailable: true, uploadAudio: () => {
      if (++calls === 1) throw Object.assign(new Error('Upload failed'), { status });
      return retry.promise;
    } } });
    await f.flow.start(); await f.flow.stop();
    const blob = f.flow.getSnapshot().capture.blob;
    assert.equal(f.flow.getSnapshot().phase, 'review');
    assert.equal(f.flow.getSnapshot().uploadStatus, 'failed');
    assert.ok(f.flow.getSnapshot().capture.url);
    f.flow.edit('Kept manual draft'); await tick();
    assert.equal(calls, 1);
    const pending = f.flow.transcribe(); await f.flow.transcribe();
    assert.equal(calls, 2);
    assert.equal(f.uploads[1].blob, blob);
    retry.resolve({ transcript: 'Full uploaded text', outcome: 'transcribed' }); await pending;
    assert.equal(f.flow.getSnapshot().editorText, 'Kept manual draft');
    assert.equal(f.flow.getSnapshot().uploadTranscript, 'Full uploaded text');
    await f.flow.transcribe(); assert.equal(calls, 2);
    f.flow.useUploadTranscript();
    assert.equal(f.flow.getSnapshot().editorText, 'Full uploaded text');
    assert.equal(f.saves.length, 0);
    f.cleanup();
  }
});

test('server rejections that need a new recording do not offer an unsafe retry', async () => {
  for (const status of [413, 415, 422]) {
    const uploadAudio = createAudioUpload({ apiUrl: 'http://api.test', getAuthEpoch: () => 0,
      fetch: async () => new Response('rejected', { status }) });
    const f = fixture({ services: { transcriptionAvailable: false, uploadAvailable: true, uploadAudio } });
    await f.flow.start(); await f.flow.stop();
    assert.equal(f.flow.getSnapshot().canUpload, false);
    assert.ok(f.flow.getSnapshot().capture.blob);
    f.flow.edit('Manually reviewed'); await f.flow.save();
    assert.equal(f.saves[0].content, 'Manually reviewed');
    f.cleanup();
  }
});

test('cancel keeps audio and edits; a late result cannot replace a newer retry', async () => {
  const old = deferred(), retry = deferred(); let calls = 0;
  const f = fixture({ services: { transcriptionAvailable: false, uploadAvailable: true,
    uploadAudio: () => ++calls === 1 ? old.promise : retry.promise } });
  await f.flow.start(); const stopping = f.flow.stop(); await tick();
  f.flow.edit('My draft');
  const blob = f.flow.getSnapshot().capture.blob;
  f.flow.cancelUpload(); await stopping;
  assert.equal(f.flow.getSnapshot().phase, 'review');
  assert.equal(f.flow.getSnapshot().uploadStatus, 'cancelled');
  assert.equal(f.uploads[0].options.signal.aborted, true);
  assert.equal(f.flow.getSnapshot().capture.blob, blob);
  const pending = f.flow.transcribe(); await f.flow.transcribe();
  old.resolve({ transcript: 'Stale old result', outcome: 'transcribed' }); await tick();
  assert.equal(f.flow.getSnapshot().phase, 'transcribing');
  assert.equal(f.flow.getSnapshot().editorText, 'My draft');
  retry.resolve({ transcript: 'New result', outcome: 'transcribed' }); await pending;
  assert.equal(f.flow.getSnapshot().editorText, 'My draft');
  assert.equal(f.flow.getSnapshot().uploadTranscript, 'New result');
  assert.equal(calls, 2);
  assert.equal(f.mediaRequests, 1);
  f.cleanup();
});

test('edits during HTTP transcription are never replaced automatically, including intentionally cleared text', async () => {
  for (const edited of ['My correction', '']) {
    const work = deferred();
    const f = fixture({ services: { transcriptionAvailable: false, uploadAvailable: true, uploadAudio: () => work.promise } });
    await f.flow.start(); const stopping = f.flow.stop(); await tick();
    f.flow.edit(edited);
    work.resolve({ transcript: 'Recognized text', outcome: 'transcribed' }); await stopping;
    assert.equal(f.flow.getSnapshot().editorText, edited);
    assert.equal(f.flow.getSnapshot().uploadTranscript, 'Recognized text');
    f.flow.useUploadTranscript();
    assert.equal(f.flow.getSnapshot().editorText, 'Recognized text');
    f.cleanup();
  }
});

test('Reset and unmount abort HTTP; late results cannot populate a newer recording', async () => {
  for (const unmount of [false, true]) {
    const work = deferred();
    const f = fixture({ services: { transcriptionAvailable: false, uploadAvailable: true, uploadAudio: () => work.promise } });
    await f.flow.start(); const stopping = f.flow.stop(); await tick();
    if (unmount) f.cleanup(); else f.flow.reset();
    await stopping;
    assert.equal(f.uploads[0].options.signal.aborted, true);
    if (!unmount) await f.flow.start();
    work.resolve({ transcript: 'Old private recording', outcome: 'transcribed' }); await tick();
    assert.equal(f.flow.getSnapshot().editorText, '');
    assert.equal(f.flow.getSnapshot().phase, unmount ? 'ready' : 'recording');
    assert.equal(f.saves.length, 0);
    if (!unmount) f.cleanup();
  }
});

test('authentication changes abort pending transcription and prevent uploading or saving the old take', async () => {
  const work = deferred();
  const f = fixture({ services: { transcriptionAvailable: false, uploadAvailable: true, uploadAudio: () => work.promise } });
  await f.flow.start(); const stopping = f.flow.stop(); await tick();
  f.flow.edit('Private draft'); const blob = f.flow.getSnapshot().capture.blob;
  f.changeAccount(); await stopping;
  assert.equal(f.uploads[0].options.signal.aborted, true);
  assert.equal(f.flow.getSnapshot().phase, 'review');
  assert.equal(f.flow.getSnapshot().uploadStatus, 'session_changed');
  assert.match(f.flow.getSnapshot().warning, /session changed/);
  assert.equal(f.flow.getSnapshot().editorText, 'Private draft');
  assert.equal(f.flow.getSnapshot().capture.blob, blob);
  work.resolve({ transcript: 'Old account', outcome: 'transcribed' }); await tick();
  await f.flow.transcribe(); await f.flow.save();
  assert.equal(f.uploads.length, 1);
  assert.equal(f.saves.length, 0);
  assert.equal(f.flow.getSnapshot().editorText, 'Private draft');
  f.cleanup();
});

test('successful live transcription and live no_speech never trigger HTTP, even when enabled', async () => {
  for (const text of ['Live confirmed text', '']) {
    const f = fixture({ services: { uploadAvailable: true, proofreadAvailable: false } });
    await f.flow.start(); if (text) f.emit(result('a', 0, text)); await f.flow.stop();
    await f.flow.transcribe();
    assert.equal(f.flow.getSnapshot().editorText, text);
    assert.equal(f.flow.getSnapshot().canUpload, false);
    assert.equal(f.uploads.length, 0);
    f.cleanup();
  }
});

test('failed live transcription offers explicit whole-audio fallback and preserves confirmed text and edits', async () => {
  const live = fixture({ services: { uploadAvailable: true } });
  await live.flow.start();
  live.emit(result('a', 0, 'Confirmed live words'));
  live.emit(result('b', 1, 'Unconfirmed tail', false)); live.failure(new Error('Connection lost'));
  await live.flow.stop();
  assert.equal(live.uploads.length, 0);
  assert.equal(live.flow.getSnapshot().canUpload, true);
  live.flow.edit('My corrected journal');
  await live.flow.transcribe();
  assert.equal(live.uploads.length, 1);
  assert.equal(live.flow.getSnapshot().originalTranscript, 'Confirmed live words');
  assert.equal(live.flow.getSnapshot().unconfirmedText, 'Unconfirmed tail');
  assert.equal(live.flow.getSnapshot().editorText, 'My corrected journal');
  assert.equal(live.flow.getSnapshot().uploadTranscript, 'Hôm nay I feel happy.');
  live.flow.useUploadTranscript();
  assert.equal(live.flow.getSnapshot().editorText, 'Hôm nay I feel happy.');
  assert.equal(live.flow.getSnapshot().originalTranscript, 'Confirmed live words');
  assert.equal(live.proofreads.length, 0);
  assert.equal(live.saves.length, 0);
  live.cleanup();
  const f = fixture({ services: { uploadAvailable: true, uploadAudio: async () => ({ transcript: '', outcome: 'no_speech' }) } });
  await f.flow.start(); f.emit(result('a', 0, 'Keep confirmed')); f.failure(new Error('Lost'));
  await f.flow.stop(); f.flow.edit('Keep my draft'); await f.flow.transcribe();
  assert.equal(f.flow.getSnapshot().editorText, 'Keep my draft');
  assert.equal(f.flow.getSnapshot().originalTranscript, 'Keep confirmed');
  assert.equal(f.flow.getSnapshot().uploadTranscript, null);
  f.cleanup();
});

test('unsupported or oversized local audio stays playable and editable without any HTTP request', async () => {
  for (const oversized of [false, true]) {
    const f = fixture({ mimeType: oversized ? undefined : 'audio/mp4',
      services: { transcriptionAvailable: false, uploadAvailable: true } });
    await f.flow.start(); if (oversized) f.device.chunk(new Uint8Array(10 * 1024 * 1024));
    await f.flow.stop();
    assert.equal(f.flow.getSnapshot().phase, 'review');
    assert.equal(f.flow.getSnapshot().uploadStatus, 'unavailable');
    assert.match(f.flow.getSnapshot().error, oversized ? /10 MiB/ : /format/);
    assert.ok(f.flow.getSnapshot().capture.url);
    assert.equal(f.uploads.length, 0);
    f.flow.edit('Manual review'); await f.flow.save();
    assert.equal(f.saves[0].content, 'Manual review');
    f.cleanup();
  }
});

test('overlong HTTP transcripts are retained exactly and use existing save validation', async () => {
  const transcript = '😀'.repeat(5001);
  const f = fixture({ services: { transcriptionAvailable: false, uploadAvailable: true,
    uploadAudio: async () => ({ transcript, outcome: 'transcribed' }) } });
  await f.flow.start(); await f.flow.stop();
  assert.equal(f.flow.getSnapshot().editorText, transcript);
  await f.flow.save(); assert.equal(f.saves.length, 0);
  f.flow.edit('Shortened after review'); await f.flow.save();
  assert.equal(f.saves[0].content, 'Shortened after review');
  f.cleanup();
});

function socketFixture(options = {}) {
  let socket, timerId = 0;
  const timers = new Map(), delays = new Map(), messages = [], failures = [], segments = [];
  class Socket extends EventTarget {
    constructor() { super(); socket = this; this.readyState = 1; this.bufferedAmount = 0; }
    send(value) { messages.push(value); }
    close() { this.readyState = 3; }
    emit(value) { this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(value) })); }
  }
  const session = createTranscriptionSession({ url: 'ws://test/api/transcriptions/live', Socket,
    onSegment: value => segments.push(value), onFailure: error => failures.push(error),
    schedule: (callback, delay) => { timers.set(++timerId, callback); delays.set(timerId, delay); return timerId; },
    cancel: id => { timers.delete(id); delays.delete(id); }, ...options });
  return { session, get socket() { return socket; }, timers, delays, messages, failures, segments };
}

function liveFixture(services = {}) {
  let wire;
  const f = fixture({ services: { proofreadAvailable: false,
    createSession: callbacks => { wire = socketFixture(callbacks); return wire.session; }, ...services } });
  return { f, get wire() { return wire; } };
}

test('Stop during provider opening keeps header/body/tail queued, then finishes once after started', async () => {
  const h = liveFixture(), { f } = h;
  const starting = f.flow.start(), w = h.wire;
  w.socket.emit({ type: 'ready', session_id: 's', accepted_mime_types: ['audio/webm;codecs=opus'] });
  await tick();
  assert.equal(f.flow.getSnapshot().phase, 'recording');
  f.device.chunk(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]));
  f.device.chunk('body');
  const stopping = f.flow.stop();
  assert.equal(f.flow.stop(), stopping);
  await tick();
  assert.equal(f.track.readyState, 'ended');
  assert.equal(f.flow.getSnapshot().phase, 'finalizing');
  assert.equal(w.messages.length, 1); // Only start; no audio/finish before started.
  assert.deepEqual(JSON.parse(w.messages[0]), { type: 'start', session_id: 's', mime_type: 'audio/webm;codecs=opus', language: 'vi' });
  w.socket.emit({ type: 'started', session_id: 's' });
  await starting; await tick();
  const audio = new Blob(w.messages.filter(message => message instanceof Blob));
  assert.deepEqual(new Uint8Array(await audio.arrayBuffer()).slice(0, 4), new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]));
  assert.equal(await audio.slice(4).text(), 'bodylast-audio');
  assert.deepEqual(JSON.parse(w.messages.at(-1)), { type: 'finish', session_id: 's' });
  assert.deepEqual([...w.delays.values()], [30000]);
  w.socket.emit({ type: 'segment', session_id: 's', ...result('a', 0, 'Hôm nay', false) });
  w.socket.emit({ type: 'segment', session_id: 's', ...result('a', 0, 'Hôm nay I am happy.', true, 1) });
  w.socket.emit({ type: 'complete', session_id: 's', final_count: 1, outcome: 'transcribed' });
  await stopping;
  assert.equal(f.flow.getSnapshot().editorText, 'Hôm nay I am happy.');
  assert.equal(f.flow.getSnapshot().incomplete, false);
  assert.ok(f.flow.getSnapshot().capture.url);
  assert.equal(f.mediaRequests, 1);
  assert.equal(f.proofreads.length, 0);
  assert.equal(f.saves.length, 0);
  assert.equal(w.timers.size, 0);
  assert.equal(w.socket.readyState, 3);
  f.cleanup();
});

test('provider opening failure during Stop keeps local audio and the specific recovery message', async () => {
  const h = liveFixture(), { f } = h;
  const starting = f.flow.start(), w = h.wire;
  w.socket.emit({ type: 'ready', session_id: 's', accepted_mime_types: ['audio/webm;codecs=opus'] });
  await tick();
  const stopping = f.flow.stop();
  w.socket.emit({ type: 'error', session_id: 's', code: 'not_configured', message: 'private-provider-details' });
  await Promise.all([starting, stopping]);
  assert.equal(f.flow.getSnapshot().phase, 'review');
  assert.equal(f.flow.getSnapshot().incomplete, true);
  assert.match(f.flow.getSnapshot().warning, /not configured/);
  assert.doesNotMatch(f.flow.getSnapshot().warning, /private-provider|cancelled/);
  assert.ok(f.flow.getSnapshot().capture.url);
  assert.equal(w.messages.length, 1);
  assert.equal(w.timers.size, 0);
  assert.equal(f.saves.length, 0);
  f.cleanup();
});

test('Reset and unmount cancel opening, recording and finalization without late updates', async () => {
  for (const phase of ['ready', 'started', 'recording', 'complete']) {
    for (const unmount of [false, true]) {
      const h = liveFixture(), { f } = h;
      const starting = f.flow.start(), w = h.wire;
      if (phase !== 'ready') {
        w.socket.emit({ type: 'ready', session_id: 's', accepted_mime_types: ['audio/webm;codecs=opus'] });
        await tick();
      }
      if (['recording', 'complete'].includes(phase)) {
        w.socket.emit({ type: 'started', session_id: 's' }); await starting;
        f.device.chunk('header');
      }
      const stopping = phase === 'complete' ? f.flow.stop() : Promise.resolve();
      await tick();
      if (unmount) f.cleanup(); else f.flow.reset();
      await Promise.all([starting, stopping]);
      w.socket.emit({ type: 'started', session_id: 's' });
      w.socket.emit({ type: 'segment', session_id: 's', ...result('late', 0, 'Discarded private text') });
      w.socket.emit({ type: 'complete', session_id: 's', final_count: 1, outcome: 'transcribed' });
      assert.equal(f.flow.getSnapshot().phase, 'ready');
      assert.equal(f.flow.getSnapshot().editorText, '');
      assert.equal(f.flow.getSnapshot().capture.blob, null);
      assert.equal(w.timers.size, 0);
      assert.equal(w.socket.readyState, 3);
      assert.equal(f.saves.length, 0);
      if (phase !== 'ready') assert.equal(f.track.readyState, 'ended');
      if (!unmount) f.cleanup();
    }
  }
});

test('backend no_speech and incomplete outcomes enter manual review without AI or automatic Save', async () => {
  for (const outcome of ['no_speech', 'incomplete']) {
    const f = fixture({ session: { finish: async () => ({ final_count: outcome === 'incomplete' ? 1 : 0, outcome }) } });
    await f.flow.start();
    if (outcome === 'incomplete') {
      f.emit(result('a', 0, 'Confirmed'));
      f.emit(result('b', 1, 'Unconfirmed tail', false));
    } else {
      f.emit(result('a', 0, 'Retracted guess', false));
      f.emit(result('a', 0, '', false, 1));
    }
    await f.flow.stop();
    assert.equal(f.flow.getSnapshot().phase, 'review');
    assert.equal(f.flow.getSnapshot().incomplete, outcome === 'incomplete');
    assert.equal(f.flow.getSnapshot().editorText, outcome === 'incomplete' ? 'Confirmed' : '');
    assert.equal(f.flow.getSnapshot().unconfirmedText, outcome === 'incomplete' ? 'Unconfirmed tail' : '');
    assert.equal(f.proofreads.length, 0);
    assert.equal(f.saves.length, 0);
    f.flow.edit('Manually reviewed text'); await f.flow.save();
    assert.equal(f.saves[0].content, 'Manually reviewed text');
    f.cleanup();
  }
});

test('missing or contradictory completion outcomes preserve confirmed text as incomplete', async () => {
  for (const outcome of [undefined, 'unknown', 'no_speech', 'incomplete']) {
    const f = fixture({ session: { finish: async () => ({ final_count: 1, outcome }) } });
    await f.flow.start(); f.emit(result('a', 0, 'Kept')); await f.flow.stop();
    assert.equal(f.flow.getSnapshot().editorText, 'Kept');
    assert.equal(f.flow.getSnapshot().incomplete, true);
    assert.match(f.flow.getSnapshot().warning, /completion/);
    assert.equal(f.proofreads.length, 0);
    assert.equal(f.saves.length, 0);
    f.cleanup();
  }
});

test('backend failures have fixed actionable messages and never echo provider details', async () => {
  const messages = { not_configured: /not configured/, rate_limited: /busy/, timeout: /timed out/,
    invalid_audio: /decode/, invalid_response: /invalid transcript/, provider_unavailable: /unavailable/,
    limit_exceeded: /duration or audio-size limit/, invalid_request: /reset/, auth_expired: /log in/,
    database_unavailable: /verified/, unknown: /could not finish/, constructor: /could not finish/ };
  for (const [code, message] of Object.entries(messages)) {
    const w = socketFixture(), opening = w.session.open();
    w.socket.emit({ type: 'ready', session_id: 's', accepted_mime_types: ['audio/webm;codecs=opus'] }); await opening;
    const starting = w.session.start('audio/webm;codecs=opus');
    w.socket.emit({ type: 'error', session_id: 's', code, message: 'private-provider-details' });
    await assert.rejects(starting, message);
    assert.equal(w.failures[0].code, code);
    assert.doesNotMatch(w.failures[0].message, /private-provider/);
    assert.equal(w.timers.size, 0);
    assert.equal(w.socket.readyState, 3);
  }
});

test('expired live authentication calls the existing unauthorized handler once', async () => {
  let unauthorized = 0;
  const h = liveFixture({ unauthorized: () => unauthorized++ }), { f } = h;
  const starting = f.flow.start(), w = h.wire;
  w.socket.emit({ type: 'ready', session_id: 's', accepted_mime_types: ['audio/webm;codecs=opus'] });
  await tick();
  w.socket.emit({ type: 'error', session_id: 's', code: 'auth_expired' });
  await starting;
  assert.equal(unauthorized, 1);
  f.cleanup(); // AuthProvider/PrivatePage normally unmount on the unauthorized event.
  assert.equal(f.track.readyState, 'ended');
  assert.equal(w.timers.size, 0);
});

test('transport-level oversized audio closes with actionable local recovery', async () => {
  const w = socketFixture(), opening = w.session.open();
  w.socket.emit({ type: 'ready', session_id: 's', accepted_mime_types: ['audio/webm;codecs=opus'] }); await opening;
  w.socket.dispatchEvent(Object.assign(new Event('close'), { code: 1009 }));
  assert.match(w.failures[0].message, /audio chunk exceeded/);
  assert.equal(w.timers.size, 0);
});

test('malformed completion counts/outcomes fail and clear all finalization timers', async () => {
  for (const fields of [{ final_count: 0 }, { final_count: -1, outcome: 'no_speech' },
    { final_count: 0.5, outcome: 'transcribed' }, { final_count: 0, outcome: 'unknown' }]) {
    const w = socketFixture(), opening = w.session.open();
    w.socket.emit({ type: 'ready', session_id: 's', accepted_mime_types: ['audio/webm;codecs=opus'] }); await opening;
    const starting = w.session.start('audio/webm;codecs=opus');
    w.socket.emit({ type: 'started', session_id: 's' }); await starting;
    const finishing = w.session.finish();
    w.socket.emit({ type: 'complete', session_id: 's', ...fields });
    await assert.rejects(finishing, /Invalid transcription completion/);
    assert.equal(w.timers.size, 0);
    assert.equal(w.socket.readyState, 3);
  }
});

test('WebSocket adapter preserves header/tail order and finish follows the last audio frame', async () => {
  const f = socketFixture(); const opening = f.session.open();
  f.socket.emit({ type: 'ready', session_id: 's', accepted_mime_types: ['audio/webm;codecs=opus'] }); await opening;
  f.session.push(new Blob(['header']));
  const starting = f.session.start('audio/webm;codecs=opus');
  f.socket.emit({ type: 'started', session_id: 's' }); await starting;
  f.session.push(new Blob(['tail']));
  const finished = f.session.finish();
  assert.equal(JSON.parse(f.messages[0]).type, 'start');
  assert.equal(await f.messages[1].text(), 'header');
  assert.equal(await f.messages[2].text(), 'tail');
  assert.equal(JSON.parse(f.messages[3]).type, 'finish');
  f.socket.emit({ type: 'segment', session_id: 'old', ...result('old', 0, 'ignore') });
  f.socket.emit({ type: 'error', session_id: 'old', code: 'auth_expired' });
  assert.equal(f.failures.length, 0);
  f.socket.emit({ type: 'segment', session_id: 's', ...result('a', 0, 'final') });
  f.socket.emit({ type: 'complete', session_id: 's', final_count: 1, outcome: 'transcribed' });
  assert.equal((await finished).final_count, 1);
  assert.equal(f.segments.length, 1);
  assert.equal(f.timers.size, 0);
  assert.equal(f.socket.readyState, 3);
});

test('WebSocket handshake/finalization deadlines, cancellation and backpressure close cleanly', async () => {
  const f = socketFixture(); const opening = f.session.open();
  [...f.timers.values()][0](); await assert.rejects(opening, /connect in time/);
  assert.equal(f.socket.readyState, 3);
  assert.equal(f.timers.size, 0);
  const limited = socketFixture({ maxBufferedBytes: 2 }); const opened = limited.session.open();
  limited.socket.emit({ type: 'ready', session_id: 's', accepted_mime_types: ['audio/webm'] }); await opened;
  limited.session.push(new Blob(['too much']));
  assert.equal(limited.failures.length, 1);
  assert.equal(limited.socket.readyState, 3);
  const last = socketFixture(); const ready = last.session.open();
  last.socket.emit({ type: 'ready', session_id: 's', accepted_mime_types: ['audio/webm'] }); await ready;
  const started = last.session.start('audio/webm'); last.socket.emit({ type: 'started', session_id: 's' }); await started;
  const ending = last.session.finish(); [...last.timers.values()][0]();
  await assert.rejects(ending, /Final transcription/);
  const cancelled = socketFixture(); const pending = cancelled.session.open(); cancelled.session.close();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(cancelled.timers.size, 0);
});
