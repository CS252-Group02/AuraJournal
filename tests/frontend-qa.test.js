import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function loadQa(api = () => { throw new Error('Unexpected network request'); }) {
  globalThis.__qaTestApi = api;
  const source = (await readFile(new URL('../src/frontend/src/features/qa/journalQaApi.js', import.meta.url), 'utf8'))
    .replace("import { api } from '../../lib/api.js';", 'const api = globalThis.__qaTestApi;');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${Math.random()}`);
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('asking posts only the question to the ask endpoint', async () => {
  const calls = [];
  const { askJournals } = await loadQa((path, options) => { calls.push({ path, options }); return Promise.resolve({}); });
  const signal = new AbortController().signal;
  await askJournals('Where did I have coffee?', { signal });
  assert.deepEqual(calls, [{ path: '/api/entries/ask', options: { method: 'POST', body: { question: 'Where did I have coffee?' }, signal } }]);
});

test('blank and oversized questions never reach the network', async () => {
  const { createAskLoader, MAX_QUESTION_LENGTH } = await loadQa();
  const states = [];
  const loader = createAskLoader({ onChange: (state) => states.push(state) });
  await loader.ask('   ');
  await loader.ask('a'.repeat(MAX_QUESTION_LENGTH + 1));
  assert.deepEqual(states.map((state) => state.status), ['invalid', 'invalid']);
});

test('answered and insufficient-evidence results map to separate states', async () => {
  const { createAskLoader } = await loadQa();
  const states = [];
  const replies = [
    { status: 'answered', answer: 'At the riverside cafe.', source_dates: ['2026-11-18'] },
    { status: 'insufficient_evidence', answer: 'Not enough in your journals.', source_dates: [] },
  ];
  const loader = createAskLoader({ request: () => Promise.resolve(replies.shift()), onChange: (state) => states.push(state) });
  await loader.ask(' Where did I have coffee? ');
  await loader.ask('What did I eat in 2019?');
  assert.deepEqual(states.map((state) => state.status), ['loading', 'answered', 'loading', 'no-evidence']);
  assert.equal(states[1].question, 'Where did I have coffee?');
  assert.deepEqual(states[1].data.source_dates, ['2026-11-18']);
});

test('a newer question replaces an older pending one', async () => {
  const { createAskLoader } = await loadQa();
  const first = deferred();
  const second = deferred();
  const pending = [first, second];
  const signals = [];
  const states = [];
  const loader = createAskLoader({
    request: (question, { signal }) => { signals.push(signal); return pending.shift().promise; },
    onChange: (state) => states.push(state),
  });
  const older = loader.ask('first');
  const newer = loader.ask('second');
  assert.ok(signals[0].aborted);
  first.resolve({ status: 'answered', answer: 'old', source_dates: ['2026-11-01'] });
  second.resolve({ status: 'answered', answer: 'new', source_dates: ['2026-11-02'] });
  await Promise.all([older, newer]);
  assert.deepEqual(states.filter((state) => state.status === 'answered').map((state) => state.data.answer), ['new']);
});

test('errors become readable messages and source days link to History', async () => {
  const { createAskLoader, qaErrorMessage, sourceDayPath } = await loadQa();
  const states = [];
  const failure = Object.assign(new Error('raw'), { status: 429 });
  const loader = createAskLoader({ request: () => Promise.reject(failure), onChange: (state) => states.push(state) });
  await loader.ask('Anything?');
  assert.equal(states.at(-1).status, 'error');
  assert.equal(states.at(-1).code, 429);
  assert.match(states.at(-1).error, /Wait a moment/);
  assert.match(qaErrorMessage(new TypeError('fetch failed')), /connection/);
  assert.equal(qaErrorMessage({ status: 400, message: 'Server said no.' }), 'Server said no.');
  assert.equal(sourceDayPath('2026-11-18'), '/history?start=2026-11-18&end=2026-11-18');
});
