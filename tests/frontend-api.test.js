import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createAudioUpload, MAX_AUDIO_UPLOAD_BYTES, recordingUploadError } from '../src/frontend/src/features/record/audioUpload.js';

test('API sends an idempotency key only when explicitly supplied', async () => {
  const original = globalThis.fetch;
  const headers = [];
  try {
    globalThis.fetch = async (url, options) => {
      headers.push(options.headers);
      return new Response('{"id":"entry"}', { status: 201 });
    };
    const { api } = await loadApi();
    await api('/api/entries', { method: 'POST', body: { content: 'edited' }, idempotencyKey: 'same-attempt' });
    await api('/api/entries', { method: 'POST', body: { content: 'ordinary' } });
    assert.equal(headers[0]['Idempotency-Key'], 'same-attempt');
    assert.equal(headers[0]['X-AuraJournal-CSRF'], '1');
    assert.equal(headers[1]['Idempotency-Key'], undefined);
  } finally { globalThis.fetch = original; }
});

async function loadApi() {
  const source = (await readFile(new URL('../src/frontend/src/lib/api.js', import.meta.url), 'utf8'))
    .replace('import.meta.env.VITE_API_URL', "''");
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${Math.random()}`);
}

test('API sends cookies, JSON, and CSRF headers', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'http://localhost:8000/api/entries');
      assert.equal(options.credentials, 'include');
      assert.equal(options.headers['X-AuraJournal-CSRF'], '1');
      assert.equal(options.body, '{"content":"hello"}');
      return new Response('{"id":"example"}', { status: 201 });
    };
    const { api } = await loadApi();
    assert.deepEqual(await api('/api/entries', { method: 'POST', body: { content: 'hello' } }), { id: 'example' });
  } finally { globalThis.fetch = original; }
});

test('old journal responses cannot update a different session', async () => {
  const original = globalThis.fetch;
  try {
    let release;
    globalThis.fetch = () => new Promise((resolve) => { release = resolve; });
    const { api, changeAuthEpoch } = await loadApi();
    const result = api('/api/entries');
    changeAuthEpoch();
    release(new Response('[{"content":"previous account"}]'));
    await assert.rejects(result, /Session changed/);
  } finally { globalThis.fetch = original; }
});

test('session switches while parsing also discard private content', async () => {
  const original = globalThis.fetch;
  try {
    let release;
    globalThis.fetch = async () => ({ status: 200, ok: true,
      json: () => new Promise((resolve) => { release = resolve; }),
    });
    const { api, changeAuthEpoch } = await loadApi();
    const result = api('/api/entries');
    await Promise.resolve();
    changeAuthEpoch();
    release([{ content: 'previous account' }]);
    await assert.rejects(result, /Session changed/);
  } finally { globalThis.fetch = original; }
});

test('anonymous session checks and wrong passwords do not trigger global logout', async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  try {
    const events = [];
    globalThis.window = { dispatchEvent: (event) => events.push(event.type) };
    globalThis.fetch = async () => new Response('{"detail":"Please log in."}', { status: 401 });
    const { api } = await loadApi();
    await assert.rejects(api('/api/auth/me'), { status: 401 });
    await assert.rejects(api('/api/auth/login'), { status: 401 });
    assert.deepEqual(events, []);
    await assert.rejects(api('/api/entries'), { status: 401 });
    assert.deepEqual(events, ['aurajournal:unauthorized']);
  } finally { globalThis.fetch = originalFetch; globalThis.window = originalWindow; }
});

const recording = () => new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), 'completed-audio'], { type: 'audio/webm;codecs=opus' });

function uploadFixture(send) {
  let epoch = 0;
  const listeners = new Set(), calls = [];
  const upload = createAudioUpload({ apiUrl: 'https://api.example.test', getAuthEpoch: () => epoch,
    subscribeAuthChanges(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    fetch: async (url, options) => { calls.push({ url, ...options }); return send(url, options); },
  });
  return { upload, calls, listeners, changeAccount() { epoch++; listeners.forEach(listener => listener()); } };
}

test('audio upload sends the completed Blob as exact raw bytes, with cookies, CSRF and cancellation', async () => {
  const transcript = '  Hôm nay\nI feel happy. 😀  ';
  const f = uploadFixture(async () => new Response(JSON.stringify({ transcript, outcome: 'transcribed' })));
  const blob = recording(), controller = new AbortController();
  assert.deepEqual(await f.upload(blob, { signal: controller.signal }), { transcript, outcome: 'transcribed' });
  const call = f.calls[0];
  assert.equal(call.url, 'https://api.example.test/api/transcriptions');
  assert.equal(call.method, 'POST');
  assert.equal(call.credentials, 'include');
  assert.deepEqual(call.headers, { 'Content-Type': 'audio/webm;codecs=opus', 'X-AuraJournal-CSRF': '1' });
  assert.equal(call.body, blob);
  assert.deepEqual(await call.body.arrayBuffer(), await blob.arrayBuffer());
  assert.ok(call.signal instanceof AbortSignal);
  assert.equal(f.calls.length, 1);
  assert.equal(f.listeners.size, 0);
});

test('audio validation rejects empty, non-Blob, unsupported and oversized recordings before fetch', async () => {
  const f = uploadFixture(() => { throw new Error('Must not fetch'); });
  for (const blob of [null, 'audio', new Blob([], { type: 'audio/webm;codecs=opus' }),
    ...['audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm;codecs=opus;extra=1'].map(type => new Blob(['audio'], { type })),
    new Blob([new Uint8Array(MAX_AUDIO_UPLOAD_BYTES + 1)], { type: 'audio/webm;codecs=opus' })]) {
    await assert.rejects(f.upload(blob), { retryable: false });
  }
  assert.equal(f.calls.length, 0);
  assert.equal(recordingUploadError(new Blob([new Uint8Array(MAX_AUDIO_UPLOAD_BYTES)], { type: 'audio/webm;codecs=opus' })), '');
  assert.equal(recordingUploadError(new Blob(['audio'], { type: 'Audio/WebM; codecs="Opus"' })), '');
});

test('HTTP upload errors use recoverable safe messages without automatic retries or global logout', async () => {
  const messages = new Map([[400, /interrupted/], [401, /session expired/], [403, /security check/],
    [413, /limit/], [415, /format/], [422, /decoded/], [429, /Try again in 5 seconds/],
    [502, /invalid transcript/], [503, /unavailable/], [504, /timed out/], [500, /failed/]]);
  for (const [status, message] of messages) {
    const f = uploadFixture(() => new Response('private provider details', { status, headers: { 'Retry-After': '5' } }));
    await assert.rejects(f.upload(recording()), error => {
      assert.equal(error.status, status);
      assert.match(error.message, message);
      assert.doesNotMatch(error.message, /private provider/);
      assert.equal(error.retryable, ![413, 415, 422].includes(status));
      return true;
    });
    assert.equal(f.calls.length, 1);
    assert.equal(f.listeners.size, 0);
  }
});

test('network loss and malformed or contradictory success responses never become transcripts', async () => {
  for (const send of [() => { throw new TypeError('network disconnected'); },
    () => new Response('<html>proxy error</html>'),
    ...[null, {}, { transcript: 2, outcome: 'transcribed' }, { transcript: ' ', outcome: 'transcribed' },
      { transcript: 'unconfirmed', outcome: 'incomplete' }, { transcript: 'words', outcome: 'no_speech' }]
      .map(value => () => new Response(JSON.stringify(value)))]) {
    const f = uploadFixture(send);
    await assert.rejects(f.upload(recording()), /recording is kept/);
    assert.equal(f.calls.length, 1);
  }
  const f = uploadFixture(() => new Response('{"transcript":"","outcome":"no_speech"}'));
  assert.deepEqual(await f.upload(recording()), { transcript: '', outcome: 'no_speech' });
});

test('aborted uploads settle immediately even when fetch ignores the signal; pre-abort sends nothing', async () => {
  const f = uploadFixture(() => new Promise(() => {}));
  const controller = new AbortController(), pending = f.upload(recording(), { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(f.calls[0].signal.aborted, true);
  assert.equal(f.listeners.size, 0);
  await assert.rejects(f.upload(recording(), { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(f.calls.length, 1);
});

test('authentication changes cancel uploads while fetching or parsing and ignore private late results', async () => {
  for (const parsing of [false, true]) {
    let release;
    const f = uploadFixture(() => parsing
      ? { ok: true, json: () => new Promise(resolve => { release = resolve; }) }
      : new Promise(resolve => { release = resolve; }));
    const pending = f.upload(recording());
    for (let i = 0; i < 5; i++) await Promise.resolve();
    f.changeAccount();
    await assert.rejects(pending, { code: 'session_changed' });
    assert.equal(f.calls[0].signal.aborted, true);
    release(parsing ? { transcript: 'Old account', outcome: 'transcribed' } : new Response('{"transcript":"Old account","outcome":"transcribed"}'));
    assert.equal(f.calls.length, 1);
    assert.equal(f.listeners.size, 0);
  }
});

test('auth epoch subscriptions notify once per change and release listeners', async () => {
  const api = await loadApi(); let changes = 0;
  const unsubscribe = api.subscribeAuthChanges(() => changes++);
  api.changeAuthEpoch(); api.changeAuthEpoch();
  assert.equal(changes, 2);
  unsubscribe(); api.changeAuthEpoch();
  assert.equal(changes, 2);
});

test('malformed HTTP errors retain status, safe messages and quota metadata with one attempt', async () => {
  const original = globalThis.fetch;
  try {
    const { api } = await loadApi();
    for (const status of [429, 502, 503, 504, 500]) {
      for (const body of ['<html>PRIVATE-provider</html>', '', '{"detail":{"PRIVATE":"provider"}}',
        '{"detail":[null]}', '{"detail":"PRIVATE-provider"}']) {
        let calls = 0;
        globalThis.fetch = async () => { calls++; return new Response(body, { status, headers: { 'Retry-After': '5' } }); };
        await assert.rejects(api('/api/entries/ask', { method: 'POST', body: { question: 'Coffee?' } }), error => {
          assert.equal(error.status, status);
          assert.doesNotMatch(error.message, /PRIVATE|JSON|Unexpected token|object Object/);
          if (status === 429) assert.equal(error.retryAfter, 5);
          return true;
        });
        assert.equal(calls, 1);
      }
    }
    globalThis.fetch = async () => new Response('{"detail":[{"loc":["body","question"],"msg":"Field required"}]}', { status: 422 });
    await assert.rejects(api('/api/entries/ask'), { status: 422, message: 'question: Field required' });
    globalThis.fetch = async () => new Response('{"detail":[{"loc":null,"msg":"PRIVATE"}]}', { status: 422 });
    await assert.rejects(api('/api/entries/ask'), { status: 422, message: 'The request failed. Please try again.' });
  } finally { globalThis.fetch = original; }
});

test('non-JSON unauthorized responses still trigger session recovery except auth probes', async () => {
  const originalFetch = globalThis.fetch, originalWindow = globalThis.window;
  try {
    const events = [];
    globalThis.window = { dispatchEvent: event => events.push(event.type) };
    globalThis.fetch = async () => new Response('<html>PRIVATE</html>', { status: 401 });
    const { api } = await loadApi();
    for (const path of ['/api/auth/me', '/api/auth/login', '/api/weekly-reflections']) {
      await assert.rejects(api(path), { status: 401, message: 'Your session expired. Please log in again.' });
    }
    assert.deepEqual(events, ['aurajournal:unauthorized']);
  } finally { globalThis.fetch = originalFetch; globalThis.window = originalWindow; }
});

test('JSON requests reject network, malformed success and cancellation without leaking raw errors', async () => {
  const original = globalThis.fetch;
  try {
    const { api } = await loadApi();
    globalThis.fetch = async () => { throw new TypeError('PRIVATE network diagnostics'); };
    await assert.rejects(api('/api/entries/ask'), /Check your connection/);
    globalThis.fetch = async () => new Response('<html>PRIVATE</html>');
    await assert.rejects(api('/api/reflections/weekly'), { status: 502, message: 'The server returned an invalid response. Please try again.' });
    const controller = new AbortController();
    globalThis.fetch = async () => { controller.abort(); return new Response('{}'); };
    await assert.rejects(api('/api/entries/ask', { signal: controller.signal }), { name: 'AbortError' });
    globalThis.fetch = () => { throw new Error('Pre-abort must not fetch'); };
    await assert.rejects(api('/api/entries/ask', { signal: controller.signal }), { name: 'AbortError' });
  } finally { globalThis.fetch = original; }
});

test('real API failures settle Q&A and recap loaders and leave retry available', async () => {
  const original = globalThis.fetch;
  try {
    const { api } = await loadApi();
    for (const [file, factory] of [
      ['qa/journalQaApi.js', 'createAskLoader'], ['reflection/reflectionApi.js', 'createRecapLoader'],
    ]) {
      globalThis.__a10Api = api;
      const source = (await readFile(new URL(`../src/frontend/src/features/${file}`, import.meta.url), 'utf8'))
        .replace("import { api } from '../../lib/api.js';", 'const api = globalThis.__a10Api;');
      const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${Math.random()}`);
      const states = [], loader = module[factory]({ onChange: state => states.push(state) });
      const run = () => factory === 'createAskLoader' ? loader.ask('Where was coffee?') : loader.run('week', '2026-11-09', 'UTC');
      for (const status of [429, 502, 503]) {
        globalThis.fetch = async () => new Response('PRIVATE proxy diagnostics', { status });
        await run();
        assert.equal(states.at(-1).status, 'error');
        assert.equal(states.at(-1).code, status);
        assert.doesNotMatch(states.at(-1).error, /PRIVATE/);
      }
      globalThis.fetch = async () => new Response(JSON.stringify(factory === 'createAskLoader'
        ? { status: 'insufficient_evidence', answer: 'No evidence.', source_dates: [] }
        : { entry_count: 0, summary: null, highlights: [] }));
      await run();
      assert.equal(states.at(-1).status, factory === 'createAskLoader' ? 'no-evidence' : 'ready');
    }
  } finally { globalThis.fetch = original; delete globalThis.__a10Api; }
});
