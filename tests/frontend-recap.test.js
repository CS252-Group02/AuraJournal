import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { build } from 'esbuild'; // Installed by the existing Vite toolchain.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { entriesByDay, parseDateKey } from '../src/frontend/src/features/reflection/week.js';

async function loadApi(api = () => { throw new Error('Unexpected network request'); }) {
  globalThis.__recapTestApi = api;
  const source = (await readFile(new URL('../src/frontend/src/features/reflection/reflectionApi.js', import.meta.url), 'utf8'))
    .replace("import { api } from '../../lib/api.js';", 'const api = globalThis.__recapTestApi;');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${Math.random()}`);
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('saved reflections load privately and generate only through an explicit POST', async () => {
  const calls = [];
  const { readSavedReflection, generateSavedReflection } = await loadApi((path, options) => {
    calls.push({ path, options });
    return Promise.resolve({ summary: 'Saved', questions: ['One?', 'Two?'] });
  });
  assert.equal(calls.length, 0);
  const signal = new AbortController().signal;
  await readSavedReflection('2026-11-09', { signal });
  await generateSavedReflection('2026-11-09', { signal });
  assert.deepEqual(calls, [
    { path: '/api/weekly-reflections/2026-11-09', options: { signal } },
    { path: '/api/weekly-reflections', options: { method: 'POST', body: { period_start: '2026-11-09' }, signal } },
  ]);
});

test('weekly recap explicitly requests journal dates and sends the timezone', async () => {
  let called = 0;
  const signal = new AbortController().signal;
  const { fetchWeeklyRecap } = await loadApi((path, options) => {
    called += 1;
    assert.equal(path, '/api/reflections/weekly');
    assert.deepEqual(options, { method: 'POST', body: { start: '2026-11-09', timezone: 'Asia/Bangkok', date_basis: 'journal' }, signal });
    return Promise.resolve({ summary: 'A factual recap.' });
  });
  assert.equal(called, 0);
  await fetchWeeklyRecap('2026-11-09', 'Asia/Bangkok', { signal });
  assert.equal(called, 1);
});

test('a backdated journal belongs to its journal week and follows a date edit', () => {
  const entry = { id: 'backdated', journal_date: '2026-11-18', created_at: '2026-11-25T12:00:00Z' };
  const earlier = parseDateKey('2026-11-16');
  const later = parseDateKey('2026-11-23');
  assert.deepEqual(entriesByDay([entry], earlier).get('2026-11-18'), [entry]);
  assert.equal([...entriesByDay([entry], later).values()].flat().length, 0);

  const moved = { ...entry, journal_date: '2026-11-25' };
  assert.equal([...entriesByDay([moved], earlier).values()].flat().length, 0);
  assert.deepEqual(entriesByDay([moved], later).get('2026-11-25'), [moved]);
});

test('no automatic generation and old week responses are discarded after retry', async () => {
  const { createRecapLoader } = await loadApi();
  const first = deferred(), second = deferred(), changes = [], signals = [];
  const responses = [first, second];
  const loader = createRecapLoader({ onChange: (state) => changes.push(state), request: (start, timezone, { signal }) => {
    signals.push(signal); return responses.shift().promise;
  } });
  assert.deepEqual(changes, []);
  const a = loader.run('week-a', '2026-11-02', 'UTC');
  const b = loader.run('week-b', '2026-11-09', 'UTC');
  assert.equal(signals[0].aborted, true);
  second.resolve({ summary: 'Current week.' });
  await b;
  first.resolve({ summary: 'Old week.' });
  await a;
  assert.equal(changes.filter((state) => state.status === 'ready').length, 1);
  assert.equal(changes.at(-1).key, 'week-b');
});

test('unmount/account/source changes ignore late success and failure even without transport cancellation', async () => {
  const { createRecapLoader } = await loadApi();
  for (const failure of [false, true]) {
    const pending = deferred(), changes = [];
    const loader = createRecapLoader({ onChange: (state) => changes.push(state), request: () => pending.promise });
    const task = loader.run('previous-account-or-source', '2026-11-09', 'UTC');
    loader.cancel();
    if (failure) pending.reject(new Error('Late failure'));
    else pending.resolve({ summary: 'Private previous account data.' });
    await task;
    assert.deepEqual(changes.map((state) => state.status), ['loading']);
  }
});

test('source conflict and size/provider errors have actionable messages', async () => {
  const { createRecapLoader, reflectionErrorMessage } = await loadApi();
  const states = [];
  const loader = createRecapLoader({ onChange: (state) => states.push(state), request: async () => {
    throw Object.assign(new Error('Server detail'), { status: 409 });
  } });
  await loader.run('week', '2026-11-09', 'UTC');
  assert.equal(states.at(-1).code, 409);
  assert.match(states.at(-1).error, /Refresh/);
  assert.match(reflectionErrorMessage({ status: 413 }), /No entries were omitted/);
  assert.match(reflectionErrorMessage({ status: 503 }), /unavailable/);
  assert.match(reflectionErrorMessage({ status: 502 }), /invalid recap/);
});

// Render real JSX with mocked auth/list data. Uses the Vite compiler dependency,
// not a second frontend framework; this is rendering coverage, not browser E2E.
async function loadPage() {
  const file = new URL('../src/frontend/src/pages/ReflectionPage.jsx', import.meta.url);
  const { fileURLToPath } = await import('node:url');
  const { dirname } = await import('node:path');
  const result = await build({
    stdin: { contents: (await readFile(file, 'utf8')) + '\nexport { RecapBody };',
      resolveDir: dirname(fileURLToPath(file)), loader: 'jsx' },
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic',
    plugins: [{ name: 'mock-page-context', setup(builder) {
      builder.onLoad({ filter: /[\\/]auth[\\/]Auth\.jsx$/ }, () => ({
        contents: 'export const useAuth = () => ({user: {id: "test-account", email: "test@example.com"}});', loader: 'js',
      }));
      builder.onLoad({ filter: /useJournalEntries\.js$/ }, () => ({
        contents: 'export const useJournalEntries = () => globalThis.__recapPageEntries;', loader: 'js',
      }));
      builder.onLoad({ filter: /[\\/]lib[\\/]api\.js$/ }, () => ({
        contents: 'export const api = () => {throw new Error("Unexpected request during render")}; export const getAuthEpoch = () => 0; export const subscribeAuthChanges = () => () => {};', loader: 'js',
      }));
    } }],
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  return module.exports;
}

test('weekly page renders factual recap controls and seven-day links, with no question panel', async () => {
  const page = await loadPage();
  globalThis.__recapPageEntries = { entries: [{ id: 'practice-entry', content: 'Finished an exam.',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString() }], status: 'ready', reload() {} };
  const html = renderToStaticMarkup(React.createElement(MemoryRouter, {}, React.createElement(page.default)));
  assert.match(html, /Weekly recap/);
  assert.match(html, /Generate weekly recap/);
  assert.match(html, /practice-entry/);
  assert.doesNotMatch(html, /Questions to sit with|Pixel-art memory|What did you learn/);
  const ready = renderToStaticMarkup(React.createElement(MemoryRouter, {}, React.createElement(page.RecapBody, {
    state: { status: 'ready', data: { summary: 'You completed an exam.', entry_count: 1,
      highlights: [{ text: 'Exam completed.', entry_ids: ['practice-entry'] }] } },
  })));
  assert.match(ready, /You completed an exam/);
  assert.match(ready, /AI-generated/);
  assert.match(ready, /Key events/);
  assert.match(ready, /Regenerate/);
  assert.match(ready, /href="\/journal\/practice-entry"/);
});
