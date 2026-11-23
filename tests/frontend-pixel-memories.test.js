import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { mapPixelMemories, memoryDates, validMemoryImage, validateMemoryFeed, hasPendingMemories, generationLabel } from '../src/frontend/src/features/pixelMemories/pixelMemoriesModel.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const feature = resolve(root, 'src/frontend/src/features/pixelMemories');
const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const entry = (number, day = '2026-11-19', extra = {}) => ({ id: id(number), journal_date: day,
  created_at: `${day}T08:00:00Z`, updated_at: `${day}T08:00:00Z`, content: `Fictional memory ${number}. A quiet walk.`, ...extra });
const record = (item, number = 100, created = '2026-11-19T10:00:00Z') => ({
  entry_id: item.id, generation: generation("ready"),
  image: { id: id(number), file_format: 'png', width: 128, height: 128, created_at: created,
    content_url: `/api/entries/${item.id}/pixel-art/content` },
});
const generation = (status, error_code = null) => ({ status, error_code, updated_at: '2026-11-19T10:00:00Z' });
const missing = (row, status = 'pending') => ({ entry_id: row.id, image: null, generation: generation(status) });
const feed = (records = [], asOf = '2026-11-19', day = asOf) => ({ as_of: asOf, days: records.length ? [{ journal_date: day, entries: records }] : [] });
const png = () => new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), 'test bytes'], { type: 'image/png' });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = () => new Promise(done => setImmediate(done));
async function settleView(f, predicate) {
  for (let i = 0; i < 100; i++) {
    await new Promise(done => setTimeout(done, 5));
    f.update();
    if (predicate(f.nodes())) return;
  }
  assert.fail('Async pixel memory view did not settle');
}

async function loadFeature(hooks) {
  const result = await build({
    stdin: { contents: 'export * from "./PixelMemories.jsx"; export {default as PixelMemories} from "./PixelMemories.jsx"; export * from "./pixelMemoriesApi.js";  export * from "../../lib/api.js";', resolveDir: feature, loader: 'jsx' },
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic',
    define: { 'import.meta.env.VITE_API_URL': '"https://api.example.test"' },
  });
  const module = { exports: {} }, require = createRequire(import.meta.url);
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(name => name === 'react' && hooks ? hooks : require(name), module, module.exports);
  return module.exports;
}
const featureModule = loadFeature();
const render = (Component, props) => renderToStaticMarkup(React.createElement(MemoryRouter, null, React.createElement(Component, props)));

test('private PNG GET uses API_URL, cookies and no-store and returns binary without JSON parsing', async () => {
  const { apiPng } = await featureModule;
  const original = globalThis.fetch, path = record(entry(1)).image.content_url;
  let calls = 0;
  try {
    globalThis.fetch = async (url, options) => {
      calls++;
      assert.equal(url, `https://api.example.test${path}`);
      assert.equal(options.credentials, 'include'); assert.equal(options.cache, 'no-store');
      assert.equal(options.redirect, 'error'); assert.equal(options.headers.Accept, 'image/png');
      assert.ok(options.signal instanceof AbortSignal);
      return new Response(png(), { headers: { 'Content-Type': 'image/png; charset=binary' } });
    };
    const result = await apiPng(path);
    assert.ok(result instanceof Blob);
    assert.deepEqual(await result.arrayBuffer(), await png().arrayBuffer());
    for (const invalid of ['https://other.test/image', `//other.test${path}`, `${path}?token=x`, `${path}#x`,
      `/api/entries/${id(1)}/../pixel-art/content`, path.replace('/pixel-art/', '/%70ixel-art/'), '/api/auth/me', null]) {
      await assert.rejects(apiPng(invalid), /Invalid pixel image path/);
    }
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('PNG validation rejects wrong types, empty, oversized and invalid bytes', async () => {
  const { apiPng } = await featureModule;
  const original = globalThis.fetch, path = record(entry(1)).image.content_url;
  try {
    for (const response of [new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } }),
      new Response(png(), { headers: { 'Content-Type': 'application/json' } }),
      new Response('', { headers: { 'Content-Type': 'image/png' } }),
      new Response('not png', { headers: { 'Content-Type': 'image/png' } }),
      new Response(new Uint8Array(2 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'image/png' } })]) {
      globalThis.fetch = async () => response;
      await assert.rejects(apiPng(path), /PNG|size/);
    }
  } finally { globalThis.fetch = original; }
});

test('401, 403, 404, 429, 503 and 504 propagate from metadata and PNG with no retries; 401 expires auth', async () => {
  const { apiPng, fetchMemoryFeed, pixelMemoryError } = await featureModule;
  const original = globalThis.fetch, oldWindow = globalThis.window, events = [];
  globalThis.window = { dispatchEvent: event => events.push(event.type) };
  try {
    for (const status of [401, 403, 404, 429, 503, 504]) {
      let calls = 0;
      globalThis.fetch = async () => { calls++; return new Response('{"detail":"private internal detail"}', { status }); };
      for (const request of [() => apiPng(record(entry(1)).image.content_url), () => fetchMemoryFeed('2026-11-19')]) {
        await assert.rejects(request(), error => { assert.equal(error.status, status); return true; });
      }
      assert.equal(calls, 2);
      assert.doesNotMatch(pixelMemoryError({ status }), /private internal detail/);
      assert.match(pixelMemoryError({ status }), /session|Access|available|busy|timed out/);
    }
    assert.deepEqual(events, ['aurajournal:unauthorized', 'aurajournal:unauthorized']);
  } finally { globalThis.fetch = original; globalThis.window = oldWindow; }
});

test('PNG cancellation and session changes reject late fetch and Blob results before use', async () => {
  const { apiPng, changeAuthEpoch } = await featureModule;
  const original = globalThis.fetch, path = record(entry(1)).image.content_url;
  try {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response(png()); };
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(apiPng(path, { signal: aborted.signal }), { name: 'AbortError' });
    assert.equal(calls, 0);
    for (const phase of ['fetch', 'blob']) {
      for (const action of ['cancel', 'account']) {
        const held = deferred(), controller = new AbortController(); let sentSignal;
        globalThis.fetch = (url, options) => {
          sentSignal = options.signal;
          return phase === 'fetch' ? held.promise : Promise.resolve({ ok: true,
            headers: new Headers({ 'Content-Type': 'image/png' }), blob: () => held.promise });
        };
        const pending = apiPng(path, { signal: controller.signal });
        await flush();
        if (action === 'account') changeAuthEpoch(); else controller.abort();
        assert.equal(sentSignal.aborted, true);
        held.resolve(phase === 'fetch' ? new Response(png()) : png());
        await assert.rejects(pending, action === 'account' ? /Session changed/ : { name: 'AbortError' });
      }
    }
  } finally { globalThis.fetch = original; }
});

function sessionFixture() {
  let epoch = 0;
  const listeners = new Set();
  return { getEpoch: () => epoch, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    listeners, change() { epoch++; [...listeners].forEach(listener => listener()); } };
}

test('image lifecycle creates and revokes URLs on replacement, decode failure, logout and unmount', async () => {
  const { createMemoryImageLoader } = await featureModule;
  const session = sessionFixture(), changes = [], created = [], revoked = [];
  const loader = createMemoryImageLoader({ ...session, onChange: state => changes.push(state), request: async () => png(),
    createURL: blob => { assert.ok(blob instanceof Blob); const url = `blob:test-${created.length}`; created.push(url); return url; },
    revokeURL: url => revoked.push(url) });
  await loader.load('first'); assert.equal(changes.at(-1).url, created[0]);
  await loader.load('second'); assert.deepEqual(revoked, [created[0]]);
  loader.unavailable(created[0]); assert.equal(changes.at(-1).status, 'ready'); // Late decoder failure from old image.
  loader.unavailable(); assert.equal(changes.at(-1).status, 'error'); assert.deepEqual(revoked, created);
  await loader.load('retry'); session.change();
  assert.equal(changes.at(-1).status, 'expired'); assert.deepEqual(revoked, created);
  await loader.load('again'); loader.cancel(); loader.cancel();
  assert.deepEqual(revoked, created); assert.equal(session.listeners.size, 0);
});

test('unmounted and superseded image requests cannot allocate URLs or restore private images', async () => {
  const { createMemoryImageLoader } = await featureModule;
  const session = sessionFixture(), changes = [], requests = [], created = [];
  const loader = createMemoryImageLoader({ ...session, onChange: state => changes.push(state),
    request: (path, options) => { const held = deferred(); requests.push({ path, ...options, ...held }); return held.promise; },
    createURL: () => { created.push('blob:private'); return 'blob:private'; }, revokeURL() {} });
  const old = loader.load('old'), current = loader.load('current');
  requests[0].resolve(png()); await old; assert.deepEqual(created, []);
  session.change(); requests[1].resolve(png()); await current;
  assert.equal(changes.at(-1).status, 'expired'); assert.deepEqual(created, []);
  const last = loader.load('unmount'); loader.cancel(); const count = changes.length;
  requests[2].resolve(png()); await last;
  assert.equal(requests[2].signal.aborted, true); assert.equal(changes.length, count); assert.deepEqual(created, []);
});

async function interaction(exportName, initialProps) {
  const slots = []; let cursor = 0, effects = [], dirty = false, tree, props = initialProps;
  const hooks = { ...React, useMemo: fn => fn(),
    useState(initial) {
      const index = cursor++;
      slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, next => { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next; dirty = true; }];
    },
    useEffect(effect, deps) {
      const index = cursor++, previous = slots[index];
      if (!previous || deps.some((item, i) => !Object.is(item, previous.deps[i]))) {
        effects.push(() => { previous?.cleanup?.(); slots[index] = { deps, cleanup: effect() }; });
      }
    },
  };
  const module = await loadFeature(hooks);
  function nodes(value) {
    if (Array.isArray(value)) return value.flatMap(nodes);
    return React.isValidElement(value) ? [value, ...nodes(value.props.children)] : [];
  }
  function update(next = props) {
    props = next;
    for (let i = 0; i < 10; i++) {
      cursor = 0; effects = []; dirty = false; tree = module[exportName](props);
      effects.forEach(effect => effect()); if (!dirty) return;
    }
    assert.fail('Pixel memory effects did not settle');
  }
  update();
  return { update, nodes: () => nodes(tree), module, unmount() { slots.forEach(slot => slot?.cleanup?.()); } };
}


test('seven calendar slots cross leap days, months, years and supported boundaries', () => {
  assert.deepEqual(memoryDates('2027-01-02'), ['2026-12-27', '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
  assert.equal(memoryDates('2024-03-02')[4], '2024-02-29');
  assert.equal(memoryDates('2026-03-02')[4], '2026-02-28');
  assert.equal(memoryDates('1000-01-07')[0], '1000-01-01');
  assert.equal(memoryDates('9999-12-31')[6], '9999-12-31');
  for (const value of ['', null, '2026-02-30', '2026-11-19T00:00:00Z', '1000-01-01']) assert.throws(() => memoryDates(value));
});

test('local date slots remain stable through timezones and daylight saving', () => {
  const source = `import {memoryDates} from './src/frontend/src/features/pixelMemories/pixelMemoriesModel.js'; console.log(JSON.stringify(memoryDates('2026-03-10')))`;
  for (const timezone of ['UTC', 'Asia/Ho_Chi_Minh', 'America/New_York', 'Pacific/Auckland']) {
    assert.deepEqual(JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source],
      { cwd: root, encoding: 'utf8', env: { ...process.env, TZ: timezone } })),
    ['2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10']);
  }
});

test('occupied groups map to exact calendar slots without truncating same-day journals or images', () => {
  const rows = Array.from({ length: 10 }, (_, index) => entry(index + 1));
  const yesterday = entry(20, '2026-11-18'), older = entry(21, '2026-10-01');
  const grouped = feed(rows.map((row, i) => record(row, 100 + i)));
  grouped.days.push({ journal_date: yesterday.journal_date, entries: [missing(yesterday)] },
    { journal_date: older.journal_date, entries: [record(older, 120)] });
  const result = mapPixelMemories([...rows, yesterday, older], validateMemoryFeed(grouped, grouped.as_of), grouped.as_of);
  assert.equal(result.days.length, 7); assert.equal(result.days.at(-1).images.length, 10);
  assert.equal(result.days.at(-2).entries.length, 1); assert.deepEqual(result.days[0].entries, []);
  assert.equal(result.invalidCount, 0);
  assert.ok(!result.days.some(day => day.entries.some(row => row.entry_id === older.id)));
});

test('image selection starts with earliest generated artwork and binds each caption to its journal', () => {
  const rows = [entry(1), entry(2)];
  const records = [record(rows[0], 101, '2026-11-19T12:00:00Z'), record(rows[1], 102, '2026-11-19T09:00:00Z')];
  const day = mapPixelMemories(rows, feed(records), '2026-11-19').days.at(-1);
  assert.equal(day.images[0].entry.id, rows[1].id);
  assert.equal(day.images[1].entry.id, rows[0].id);
  assert.equal(day.images[0].identity, `${rows[1].id}:${id(102)}`);
});

test('deleted, foreign and moved journal associations never enter the carousel', () => {
  const row = entry(1), grouped = feed([record(row)]);
  for (const rows of [[], [entry(2)], [{ ...row, journal_date: '2026-11-18' }]]) {
    const result = mapPixelMemories(rows, grouped, grouped.as_of);
    assert.equal(result.invalidCount, 1); assert.equal(result.days.at(-1).images.length, 0);
    assert.equal(result.days.at(-1).invalid, true);
  }
});

test('grouped contract rejects malformed states, images, identity, duplicates and arbitrary URLs', () => {
  const row = entry(1), good = record(row);
  for (const image of [{}, { ...good.image, id: 'bad' }, { ...good.image, file_format: 'svg' },
    { ...good.image, width: 256 }, { ...good.image, created_at: 'invalid' },
    { ...good.image, content_url: 'https://other.test/private.png' },
    { ...good.image, content_url: `/api/entries/${id(2)}/pixel-art/content` }]) {
    assert.equal(validMemoryImage({ ...good, image }), false);
    assert.throws(() => validateMemoryFeed(feed([{ ...good, image }]), '2026-11-19'));
  }
  for (const value of [null, [], {}, { as_of: '2026-11-18', days: [] }, feed([good, good]),
    feed([{ ...good, image: null }]), feed([{ ...good, generation: generation('generating') }]),
    feed([{ ...good, generation: { status: 'pending' } }]), feed([{ ...good, generation: generation('pending', {}) }]),
    feed([{ ...good, generation: { ...generation('pending'), updated_at: '0' } }]),
    feed([{ ...good, entry_id: 'not-a-uuid' }]), feed([good], '2026-11-19', '2026-11-20')]) {
    assert.throws(() => validateMemoryFeed(value, '2026-11-19'));
  }
  const duplicateDay = feed([good]); duplicateDay.days.push({ ...duplicateDay.days[0] });
  assert.throws(() => validateMemoryFeed(duplicateDay, '2026-11-19'));
});

test('all backend states are distinct and only ready references enter a carousel', () => {
  const states = ['pending', 'processing', 'ready', 'failed', 'unavailable', 'uncertain', 'not_requested'];
  const rows = states.map((_, i) => entry(i + 1));
  const grouped = validateMemoryFeed(feed(rows.map((row, i) => states[i] === 'ready' ? record(row) : missing(row, states[i]))), '2026-11-19');
  const day = mapPixelMemories(rows, grouped, '2026-11-19').days.at(-1);
  assert.equal(day.entries.length, 7); assert.equal(day.images.length, 1);
  assert.equal(new Set(states.map(status => generationLabel(generation(status)))).size, 7);
  assert.equal(hasPendingMemories(grouped, '2026-11-19'), true);
  assert.equal(hasPendingMemories(feed([missing(rows[0], 'pending')], '2026-11-19', '2026-10-01'), '2026-11-19'), false);
  assert.equal(generationLabel(generation('failed', 'image_missing')), 'Image unavailable');
  assert.equal(generationLabel(generation('failed', 'no_depictable_moment')), 'No moment could be illustrated');
});

test('grouped API uses authenticated no-store GET and validates the actual backend response', async () => {
  const { fetchMemoryFeed } = await featureModule;
  const original = globalThis.fetch, signal = new AbortController().signal;
  let calls = 0;
  try {
    globalThis.fetch = async (url, options) => {
      calls++; assert.equal(url, 'https://api.example.test/api/entries/pixel-art/memories?as_of=2026-11-19');
      assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'include');
      assert.equal(options.cache, 'no-store'); assert.equal(options.signal, signal);
      return Response.json(feed());
    };
    assert.deepEqual(await fetchMemoryFeed('2026-11-19', { signal }), feed());
    await assert.rejects(fetchMemoryFeed('bad-date')); assert.equal(calls, 1);
    for (const body of ['[]', '{}', 'null', '<html>proxy error</html>']) {
      globalThis.fetch = async () => new Response(body);
      await assert.rejects(fetchMemoryFeed('2026-11-19'));
    }
  } finally { globalThis.fetch = original; }
});

function clockFixture() {
  let time = 0, next = 0;
  const timers = new Map();
  return { now: () => time, timers,
    setTimer(fn, delay) { const key = ++next; timers.set(key, { at: time + delay, fn }); return key; },
    clearTimer(key) { timers.delete(key); },
    async tick(ms) {
      const end = time + ms;
      for (let i = 0; i < 1000; i++) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) { time = end; await flush(); return; }
        time = due[1].at; timers.delete(due[0]); due[1].fn(); await flush();
      }
      assert.fail('Unbounded timer loop');
    },
  };
}
async function pollingFixture(overrides = {}) {
  const module = await featureModule, clock = clockFixture(), session = sessionFixture();
  const visibility = new EventTarget(); visibility.visibilityState = 'visible';
  const focus = new EventTarget(), changes = [], feeds = [], journals = [];
  const row = entry(1);
  const loader = module.createMemoriesLoader({ ...clock, ...session, visibility, focus,
    onChange: next => changes.push(next),
    request: async (date, options) => { feeds.push({ date, ...options }); return feed([missing(row)]); },
    requestEntries: async options => { journals.push(options); return [row]; }, ...overrides });
  return { ...clock, session, visibility, focus, changes, feeds, journals, loader };
}

test('polling is bounded and unchanged feeds reuse snapshot, journals and image identities', async () => {
  const f = await pollingFixture();
  try {
    await f.loader.load('2026-11-19');
    const snapshot = f.changes.at(-1).data;
    await f.tick(15000);
    assert.equal(f.feeds.length, 4); assert.equal(f.journals.length, 1);
    assert.equal(f.changes.at(-1).data, snapshot);
    await f.tick(105000); assert.equal(f.feeds.length, 24);
    assert.equal(f.changes.at(-1).windowExpired, true);
    await f.tick(300000); assert.equal(f.feeds.length, 24);
    await f.loader.refresh(); assert.equal(f.feeds.length, 25); assert.equal(f.journals.length, 2);
  } finally { f.loader.cancel(); }
  assert.equal(f.timers.size, 0);
});

test('ready artwork appears after read-only polling and terminal states stop polling', async () => {
  for (const terminal of ['ready', 'failed', 'unavailable', 'uncertain', 'not_requested']) {
    let count = 0;
    const row = entry(1);
    const f = await pollingFixture({ request: async () => feed([++count === 1 ? missing(row, 'processing')
      : terminal === 'ready' ? record(row) : missing(row, terminal)]) });
    try {
      await f.loader.load('2026-11-19'); await f.tick(5000);
      assert.equal(f.changes.at(-1).data.feed.days[0].entries[0].generation.status, terminal);
      await f.tick(300000); assert.equal(count, 2);
      assert.equal(f.changes.at(-1).windowExpired, false);
    } finally { f.loader.cancel(); }
  }
});

test('older pending occupied dates never start polling outside the seven visible slots', async () => {
  let calls = 0;
  const f = await pollingFixture({ request: async () => { calls++; return feed([missing(entry(1))], '2026-11-19', '2026-10-01'); } });
  try { await f.loader.load('2026-11-19'); await f.tick(300000); assert.equal(calls, 1); }
  finally { f.loader.cancel(); }
});

test('visibility and focus stop requests and open new bounded windows on return', async () => {
  const f = await pollingFixture();
  try {
    await f.loader.load('2026-11-19');
    f.visibility.visibilityState = 'hidden'; f.visibility.dispatchEvent(new Event('visibilitychange'));
    await f.tick(300000); assert.equal(f.feeds.length, 1);
    f.focus.dispatchEvent(new Event('focus')); await flush(); assert.equal(f.feeds.length, 1);
    f.visibility.visibilityState = 'visible'; f.visibility.dispatchEvent(new Event('visibilitychange')); await flush();
    assert.equal(f.feeds.length, 2);
    f.focus.dispatchEvent(new Event('focus')); await flush(); assert.equal(f.feeds.length, 3);
    await f.tick(5000); assert.equal(f.feeds.length, 4);
  } finally { f.loader.cancel(); }
});

test('hidden initial page waits for visibility; cancellation removes focus and auth listeners', async () => {
  const f = await pollingFixture();
  f.visibility.visibilityState = 'hidden'; await f.loader.load('2026-11-19');
  assert.equal(f.feeds.length, 0);
  f.visibility.visibilityState = 'visible'; f.visibility.dispatchEvent(new Event('visibilitychange')); await flush();
  assert.equal(f.feeds.length, 1);
  f.loader.cancel(); f.focus.dispatchEvent(new Event('focus')); f.visibility.dispatchEvent(new Event('visibilitychange'));
  await f.tick(300000); assert.equal(f.feeds.length, 1); assert.equal(f.session.listeners.size, 0);
});

test('account change, unmount, date changes and hidden tabs reject late metadata', async () => {
  for (const action of ['account', 'unmount', 'date', 'hidden']) {
    const held = deferred(); let signal;
    const f = await pollingFixture({ request: (date, options) => { signal = options.signal; return held.promise; } });
    const old = f.loader.load('2026-11-19');
    if (action === 'account') f.session.change();
    if (action === 'unmount') f.loader.cancel();
    if (action === 'hidden') { f.visibility.visibilityState = 'hidden'; f.visibility.dispatchEvent(new Event('visibilitychange')); }
    if (action === 'date') { f.loader.cancel(); }
    assert.equal(signal.aborted, true);
    const states = f.changes.length;
    held.resolve(feed([record(entry(1))])); await old;
    assert.equal(f.changes.length, states);
    if (action === 'account') { assert.equal(f.changes.at(-1).status, 'expired'); assert.equal(f.changes.at(-1).data, null); }
    f.loader.cancel();
  }
});

test('read timeout and provider-safe HTTP errors stop polling until an explicit read refresh', async () => {
  const held = deferred(); let calls = 0;
  const f = await pollingFixture({ request: async () => { calls++; return calls === 1 ? held.promise : feed(); } });
  try {
    const pending = f.loader.load('2026-11-19'); await f.tick(30000);
    assert.equal(f.changes.at(-1).status, 'error'); assert.match(f.changes.at(-1).error, /timed out/);
    held.resolve(feed()); await pending;
    await f.tick(300000); assert.equal(calls, 1); assert.equal(f.changes.at(-1).status, 'error');
    await f.loader.refresh(); assert.equal(calls, 2); assert.equal(f.changes.at(-1).status, 'ready');
  } finally { f.loader.cancel(); }
});

test('carousel arrows update artwork, caption and journal link together and respect boundaries', async () => {
  const rows = [entry(1), entry(2), entry(3)];
  const mapped = records => mapPixelMemories(rows, feed(records), '2026-11-19').days.at(-1);
  const records = rows.map((row, i) => record(row, 100 + i));
  const f = await interaction('MemoryDay', { day: mapped(records), status: 'ready' });
  const image = () => f.nodes().find(node => node.type.name === 'MemoryImage');
  const button = direction => f.nodes().find(node => node.type === 'button' && node.props['aria-label'].startsWith(direction));
  const caption = () => f.nodes().find(node => node.props.className === 'pixel-memory-caption');
  assert.equal(image().props.memory.entry_id, rows[0].id); assert.equal(button('Previous').props.disabled, true);
  button('Next').props.onClick(); f.update();
  assert.equal(image().props.memory.entry_id, rows[1].id); assert.equal(caption().props.to, `/journal/${rows[1].id}`);
  assert.equal(caption().props.children, 'Fictional memory 2');
  assert.ok(f.nodes().some(node => node.props['aria-label'] === 'Artwork 2 of 3'));
  button('Next').props.onClick(); f.update(); assert.equal(button('Next').props.disabled, true);
  const group = f.nodes().find(node => node.props.role === 'group');
  group.props.onKeyDown({ key: 'ArrowLeft', preventDefault() {} }); f.update();
  assert.equal(image().props.memory.entry_id, rows[1].id);
  f.unmount();
});

test('refresh preserves selection when new artwork appears and safely falls back after removal', async () => {
  const rows = [entry(1), entry(2), entry(3)], first = record(rows[0], 101), second = record(rows[1], 102);
  const mapped = records => mapPixelMemories(rows, feed(records), '2026-11-19').days.at(-1);
  const f = await interaction('MemoryDay', { day: mapped([first, second]), status: 'ready' });
  const selected = () => f.nodes().find(node => node.type.name === 'MemoryImage').props.memory.entry_id;
  f.nodes().find(node => node.type === 'button' && node.props['aria-label'].startsWith('Next')).props.onClick(); f.update();
  const earlier = record(rows[2], 103, '2026-11-19T07:00:00Z');
  f.update({ day: mapped([earlier, first, second]), status: 'ready' }); assert.equal(selected(), rows[1].id);
  f.update({ day: mapped([earlier, first]), status: 'ready' }); assert.equal(selected(), rows[2].id);
  f.update({ day: mapped([earlier, first, second]), status: 'ready' }); assert.equal(selected(), rows[2].id);
  f.unmount();
});

test('single ready artwork has no arrows and retains secondary statuses and every journal link', async () => {
  const rows = [entry(1), entry(2), entry(3)];
  const day = mapPixelMemories(rows, feed([record(rows[0]), missing(rows[1]), missing(rows[2], 'uncertain')]), '2026-11-19').days.at(-1);
  const { MemoryDay } = await featureModule;
  const html = render(MemoryDay, { day, status: 'ready' });
  assert.doesNotMatch(html, /Previous artwork|Next artwork/); assert.match(html, /1 artwork preparing/);
  assert.match(html, /Artwork completion unconfirmed/);
  for (const row of rows) assert.ok(html.includes(`/journal/${row.id}`));
  assert.doesNotMatch(html, /Generate|Retry generation|<select|src="https?:|src="\/api/);
});

test('empty, loading, unavailable and all backend status placeholders preserve seven dates', async () => {
  const { MemoryDays } = await featureModule;
  const row = entry(1);
  for (const status of ['pending', 'processing', 'failed', 'unavailable', 'uncertain', 'not_requested']) {
    const days = mapPixelMemories([row], feed([missing(row, status)]), '2026-11-19').days;
    const html = render(MemoryDays, { days, status: 'ready' });
    assert.equal((html.match(/data-memory-date=/g) || []).length, 7);
    assert.match(html, new RegExp(`data-generation-status="${status}"`));
    assert.equal((html.match(/>No journal</g) || []).length, 6);
  }
  const days = mapPixelMemories([], undefined, '2026-11-19').days;
  assert.match(render(MemoryDays, { days, status: 'loading' }), /Loading memories/);
  assert.match(render(MemoryDays, { days, status: 'expired' }), /Sign in to view/);
  assert.match(render(MemoryDays, { days, status: 'error' }), /Memories unavailable/);
});

test('date controls follow midnight, preserve historical dates and reject invalid/future input', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async url => Response.json(url.includes('/memories?') ? feed([], new URL(url).searchParams.get('as_of')) : []);
  const base = { todayKey: '2027-01-01', userId: 'a', timezone: 'UTC' };
  const f = await interaction('PixelMemories', base);
  try {
    const picker = () => f.nodes().find(node => node.type === 'input');
    assert.equal(picker().props.value, '2027-01-01');
    f.update({ ...base, todayKey: '2027-01-02' }); assert.equal(picker().props.value, '2027-01-02');
    picker().props.onChange({ target: { value: '2026-12-25' } }); f.update();
    for (const value of ['', '2026-02-30', '2027-01-03', '1000-01-01']) {
      picker().props.onChange({ target: { value } }); f.update(); assert.equal(picker().props.value, '2026-12-25');
    }
    f.nodes().find(node => node.type === 'button' && node.props.children === 'Today').props.onClick(); f.update();
    assert.equal(picker().props.value, '2027-01-02');
  } finally { f.unmount(); globalThis.fetch = original; }
});

test('unchanged image metadata keeps its Blob URL; retry image only downloads PNG bytes', async () => {
  const original = globalThis.fetch, oldCreate = URL.createObjectURL, oldRevoke = URL.revokeObjectURL;
  const created = [], revoked = []; let calls = 0, f;
  const row = entry(1), memory = { ...record(row), entry: row };
  try {
    globalThis.fetch = async (url, options) => {
      calls++; assert.ok(url.endsWith('/pixel-art/content')); assert.equal(options.method, undefined);
      return new Response(png());
    };
    URL.createObjectURL = () => { const url = `blob:fixture-${created.length}`; created.push(url); return url; };
    URL.revokeObjectURL = url => revoked.push(url);
    f = await interaction('MemoryImage', { memory, label: 'November 19' });
    await settleView(f, nodes => nodes.some(node => node.type === 'img'));
    f.update({ memory: { ...memory, image: { ...memory.image } }, label: 'November 19' });
    assert.equal(calls, 1); assert.equal(created.length, 1); assert.equal(revoked.length, 0);
    f.nodes().find(node => node.type === 'img').props.onError(); f.update(); assert.deepEqual(revoked, created);
    f.nodes().find(node => node.type === 'button').props.onClick(); f.update();
    await settleView(f, nodes => nodes.some(node => node.type === 'img')); assert.equal(calls, 2);
    f.module.changeAuthEpoch(); f.update(); assert.ok(!f.nodes().some(node => node.type === 'img'));
    assert.deepEqual(revoked, created);
  } finally { f?.unmount(); globalThis.fetch = original; URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke; }
});

test('gallery styles scale uncropped pixel art and put controls in flow beneath it', async () => {
  const css = await readFile(resolve(feature, 'pixelMemories.css'), 'utf8');
  assert.match(css, /image-rendering: pixelated/); assert.match(css, /object-fit: contain/);
  assert.match(css, /width: 100%; height: 100%/); assert.match(css, /aspect-ratio: 1/);
  assert.match(css, /overflow-x: auto/); assert.match(css, /grid-template-columns: repeat\(7,/);
  assert.match(css, /:focus-visible/); assert.doesNotMatch(css, /position: absolute|autoplay|animation:/);
  const dashboardCss = await readFile(resolve(root, 'src/frontend/src/styles/dashboard.css'), 'utf8');
  assert.doesNotMatch(dashboardCss, /pixelMemories/);
});

test('caption reads are scoped to visible dates and reject malformed journal identity', async () => {
  const { fetchMemoryJournals } = await featureModule;
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'https://api.example.test/api/entries?start=2026-11-13&end=2026-11-19');
      assert.equal(options.method, 'GET'); assert.equal(options.cache, 'no-store'); assert.equal(options.credentials, 'include');
      return Response.json([entry(1)]);
    };
    assert.equal((await fetchMemoryJournals({ asOf: '2026-11-19' }))[0].id, id(1));
    for (const rows of [null, {}, [{ ...entry(1), id: [id(1)] }], [{ ...entry(1), journal_date: '2026-02-30' }],
      [{ ...entry(1), content: {} }], [entry(1), entry(1)]]) {
      globalThis.fetch = async () => Response.json(rows);
      await assert.rejects(fetchMemoryJournals({ asOf: '2026-11-19' }));
    }
  } finally { globalThis.fetch = original; }
  assert.throws(() => validateMemoryFeed(feed([{ ...record(entry(1)), entry_id: [id(1)] }]), '2026-11-19'));
  assert.throws(() => validateMemoryFeed(feed([{ ...record(entry(1)), image: { ...record(entry(1)).image, id: [id(100)] } }]), '2026-11-19'));
});

test('late caption reads cannot publish old-account journals and stale ranges cannot replace new data', async () => {
  const held = deferred(), row = entry(1);
  let signal;
  const f = await pollingFixture({ request: async () => feed([record(row)]),
    requestEntries: options => { signal = options.signal; return held.promise; } });
  try {
    const pending = f.loader.load('2026-11-19'); await flush();
    f.session.change(); assert.equal(signal.aborted, true);
    held.resolve([row]); await pending;
    assert.equal(f.changes.at(-1).status, 'expired'); assert.equal(f.changes.at(-1).data, null);
  } finally { f.loader.cancel(); }
  const first = deferred(); let calls = 0;
  const next = await pollingFixture({ request: async asOf => ++calls === 1 ? first.promise : feed([], asOf) });
  try {
    const old = next.loader.load('2026-11-19');
    await next.loader.load('2026-11-12');
    first.resolve(feed([record(row)])); await old;
    assert.equal(next.changes.at(-1).asOf, '2026-11-12');
    assert.deepEqual(next.changes.at(-1).data.feed.days, []);
  } finally { next.loader.cancel(); }
});

test('PNG 404/503 recovery preserves the journal link without changing backend status or submitting work', async () => {
  const original = globalThis.fetch, oldCreate = URL.createObjectURL, oldRevoke = URL.revokeObjectURL;
  try {
    for (const code of [404, 503]) {
      let calls = 0, f;
      const row = entry(1);
      globalThis.fetch = async (url, options) => {
        assert.ok(url.endsWith('/pixel-art/content')); assert.equal(options.method, undefined);
        return ++calls === 1 ? new Response('', { status: code }) : new Response(png());
      };
      URL.createObjectURL = () => 'blob:recovered'; URL.revokeObjectURL = () => {};
      try {
        f = await interaction('MemoryImage', { memory: { ...record(row), entry: row }, label: 'November 19' });
        await settleView(f, nodes => nodes.some(node => node.type === 'button'));
        assert.equal(f.nodes().find(node => node.props.className === 'pixel-memory-art').props.to, `/journal/${row.id}`);
        f.nodes().find(node => node.type === 'button').props.onClick(); f.update();
        await settleView(f, nodes => nodes.some(node => node.type === 'img'));
        assert.equal(calls, 2);
      } finally { f?.unmount(); }
    }
  } finally { globalThis.fetch = original; URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke; }
});
