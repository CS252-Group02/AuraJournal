import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecordFlow } from '../src/frontend/src/features/record/recordFlow.js';
import { createAudioRecorder } from '../src/frontend/src/features/record/audioRecorder.js';
import { createTranscript, mergeSegment, transcriptText, contentLength, validContent } from '../src/frontend/src/features/record/transcriptState.js';
import { createTranscriptionSession } from '../src/frontend/src/features/record/transcriptionSession.js';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const result = (id, order, text, is_final = true, revision = 0) => ({ segment_id: id, order, revision, text, is_final });

function fixture(overrides = {}) {
  const track = Object.assign(new EventTarget(), { readyState: 'live', stop() { this.readyState = 'ended'; }, getSettings: () => ({ sampleRate: 48000 }) });
  let mediaRequests = 0, device, callbacks, segmentCount = 0, epoch = 0, keys = 0;
  const sent = [], proofreads = [], saves = [], revoked = [], order = [];
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  class Recorder extends EventTarget {
    static isTypeSupported(type) { return type === 'audio/webm;codecs=opus'; }
    constructor(input, options) { super(); device = this; this.mimeType = options.mimeType; this.state = 'inactive'; }
    start() { this.state = 'recording'; }
    chunk(value) { this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: new Blob([value], { type: this.mimeType }) })); }
    stop() { this.state = 'inactive'; queueMicrotask(() => { this.chunk('last-audio'); this.dispatchEvent(new Event('stop')); }); }
  }
  const recorder = createAudioRecorder({
    mediaDevices: { getUserMedia: async () => { mediaRequests++; return stream; } }, MediaRecorder: Recorder,
    urls: { createObjectURL: () => 'blob:test-take', revokeObjectURL: url => revoked.push(url) },
  });
  const session = {
    open: async () => ({ acceptedMimeTypes: ['audio/webm;codecs=opus'] }),
    start: async () => {}, push: blob => { sent.push(blob); order.push('audio'); },
    finish: async () => { order.push('finish'); return { final_count: segmentCount }; }, close() {},
    ...overrides.session,
  };
  const services = {
    transcriptionAvailable: true, proofreadAvailable: true, idempotentSaveAvailable: true,
    getAuthEpoch: () => epoch,
    createSession: handlers => { callbacks = handlers; return session; },
    proofread: async (content, options) => { proofreads.push({ content, options }); return { proofread_content: `${content}.` }; },
    save: async (content, options) => { saves.push({ content, options }); return { id: 'entry-1', content: content.trim() }; },
    ...overrides.services,
  };
  const flow = createRecordFlow({ recorder, services, makeKey: () => `key-${++keys}`, ...overrides.flow });
  const cleanup = flow.connect();
  return { flow, recorder, track, sent, proofreads, saves, revoked, order, cleanup,
    get mediaRequests() { return mediaRequests; }, get device() { return device; },
    emit(event) { callbacks.onSegment(event); segmentCount = transcriptText(flow.getSnapshot().transcript).finalCount; },
    failure(error) { callbacks.onFailure(error); }, changeAccount() { epoch++; },
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
  completion.resolve({ final_count: 2 }); await stopping;
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
  for (const finish of [async () => ({ final_count: 99 }), async () => { throw new Error('Final results timed out'); }]) {
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

function socketFixture(options = {}) {
  let socket, timerId = 0;
  const timers = new Map(), messages = [], failures = [], segments = [];
  class Socket extends EventTarget {
    constructor() { super(); socket = this; this.readyState = 1; this.bufferedAmount = 0; }
    send(value) { messages.push(value); }
    close() { this.readyState = 3; }
    emit(value) { this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(value) })); }
  }
  const session = createTranscriptionSession({ url: 'ws://test/api/transcription', Socket,
    onSegment: value => segments.push(value), onFailure: error => failures.push(error),
    schedule: callback => { timers.set(++timerId, callback); return timerId; }, cancel: id => timers.delete(id), ...options });
  return { session, get socket() { return socket; }, timers, messages, failures, segments };
}

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
  f.socket.emit({ type: 'complete', session_id: 's', final_count: 1 });
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
