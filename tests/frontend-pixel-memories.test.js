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
import { mapPixelMemories, memoryDates, validMemoryImage } from '../src/frontend/src/features/pixelMemories/pixelMemoriesModel.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const feature = resolve(root, 'src/frontend/src/features/pixelMemories');
const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const entry = (number, day = '2026-11-19', extra = {}) => ({ id: id(number), journal_date: day,
  created_at: `${day}T08:00:00Z`, updated_at: `${day}T08:00:00Z`, content: `Fictional memory ${number}. A quiet walk.`, ...extra });
const record = (item, number = 100, created = '2026-11-19T10:00:00Z') => ({
  journal_date: item.journal_date, entry_id: item.id,
  image: { id: id(number), file_format: 'png', width: 128, height: 128, created_at: created,
    content_url: `/api/entries/${item.id}/pixel-art/content` },
});
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
    stdin: { contents: 'export * from "./PixelMemories.jsx"; export {default as PixelMemories} from "./PixelMemories.jsx"; export * from "./pixelMemoriesApi.js"; export * from "../../lib/api.js";', resolveDir: feature, loader: 'jsx' },
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic',
    define: { 'import.meta.env.VITE_API_URL': '"https://api.example.test"' },
  });
  const module = { exports: {} }, require = createRequire(import.meta.url);
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(name => name === 'react' && hooks ? hooks : require(name), module, module.exports);
  return module.exports;
}
const featureModule = loadFeature();
const render = (Component, props) => renderToStaticMarkup(React.createElement(MemoryRouter, null, React.createElement(Component, props)));

test('seven consecutive calendar dates cross leap days, month and year boundaries', () => {
  assert.deepEqual(memoryDates('2027-01-02'), ['2026-12-27', '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
  assert.equal(memoryDates('2024-03-02')[4], '2024-02-29');
  assert.equal(memoryDates('2026-03-02')[4], '2026-02-28');
  for (const invalid of ['', null, '2026-02-30', '2026-11-19T00:00:00Z']) assert.throws(() => memoryDates(invalid));
});

test('local date arithmetic is stable across timezones and daylight saving changes', () => {
  const source = `import {memoryDates,mapPixelMemories} from './src/frontend/src/features/pixelMemories/pixelMemoriesModel.js';
    console.log(JSON.stringify({days:memoryDates('2026-03-10'),
      saved:mapPixelMemories([{id:'saved',journal_date:'2026-03-09',created_at:'2026-03-10T00:30:00Z'}],[],'2026-03-10').days[5].entries[0].id}));`;
  for (const timezone of ['UTC', 'Asia/Ho_Chi_Minh', 'America/New_York', 'Pacific/Auckland']) {
    const actual = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], { cwd: root, encoding: 'utf8', env: { ...process.env, TZ: timezone } }));
    assert.deepEqual(actual, { days: ['2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10'], saved: 'saved' });
  }
});

test('occupied-date metadata is filtered by calendar date without truncating same-day images', () => {
  const rows = Array.from({ length: 10 }, (_, index) => entry(index + 1));
  const older = entry(20, '2026-10-01'), noImage = entry(21, '2026-11-18');
  const records = [...rows.map((item, index) => record(item, 100 + index)), record(older, 120)];
  const mapped = mapPixelMemories([...rows, older, noImage], records, '2026-11-19');
  assert.equal(mapped.days.length, 7);
  assert.equal(mapped.days.at(-1).images.length, 10);
  assert.equal(mapped.days.at(-1).entries.length, 10);
  assert.equal(mapped.days.at(-2).entries.length, 1);
  assert.equal(mapped.days.at(-2).images.length, 0);
  assert.deepEqual(mapped.days[0].entries, []);
  assert.equal(mapped.invalidCount, 0);
  assert.ok(!mapped.days.some(day => day.images.some(image => image.entry_id === older.id)));
});

test('newest image represents its own journal, with stable ties and every other journal retained', () => {
  const newestJournal = entry(1), olderJournal = entry(2, '2026-11-19', { created_at: '2026-11-19T07:00:00Z' });
  const first = record(newestJournal, 101, '2026-11-19T09:00:00Z');
  const recentImage = record(olderJournal, 102, '2026-11-19T11:00:00Z');
  const rows = Object.freeze([Object.freeze(newestJournal), Object.freeze(olderJournal)]);
  const result = mapPixelMemories(rows, Object.freeze([first, recentImage, recentImage]), '2026-11-19').days.at(-1);
  assert.equal(result.images[0].entry.id, olderJournal.id);
  assert.equal(result.images.length, 2);
  assert.deepEqual(result.entries, rows);
  const ties = mapPixelMemories(rows, [record(olderJournal, 102), record(newestJournal, 101)], '2026-11-19').days.at(-1);
  assert.equal(ties.images[0].entry_id, newestJournal.id);
});

test('missing, malformed, foreign, moved and ambiguous metadata never become a wrong memory', () => {
  const saved = entry(1), good = record(saved);
  for (const image of [null, {}, { ...good.image, id: 'bad' }, { ...good.image, file_format: 'svg' },
    { ...good.image, width: 256 }, { ...good.image, created_at: 'invalid' }, { ...good.image, created_at: '0' },
    { ...good.image, content_url: 'https://other.test/private.png' },
    { ...good.image, content_url: `/api/entries/${id(2)}/pixel-art/content` }]) {
    assert.equal(Boolean(validMemoryImage({ ...good, image })), false);
    const result = mapPixelMemories([saved], [{ ...good, image }], '2026-11-19');
    assert.equal(result.days.at(-1).images.length, 0);
    assert.equal(result.days.at(-1).invalid, true);
  }
  const result = mapPixelMemories([saved], [null, {}, record(entry(2)), { ...good, journal_date: '2026-11-18' }], '2026-11-19');
  assert.equal(result.invalidCount, 4);
  assert.ok(result.days.every(day => day.images.length === 0));
  assert.equal(mapPixelMemories([], [good], '2026-11-19').days.at(-1).images.length, 0); // Deleted entry.
  assert.equal(mapPixelMemories([{ ...saved, journal_date: '2026-11-18' }], [good], '2026-11-19').days.at(-2).images.length, 0);
  const movedFromOlderDate = mapPixelMemories([saved], [{ ...good, journal_date: '2026-10-01' }], '2026-11-19');
  assert.equal(movedFromOlderDate.days.at(-1).invalid, true);
  const ambiguous = mapPixelMemories([saved], [good, record(saved, 101)], '2026-11-19');
  assert.equal(ambiguous.days.at(-1).images.length, 0);
  assert.equal(ambiguous.days.at(-1).invalid, true);
});

test('metadata GET uses the exact as_of contract with cookies, CSRF and cancellation', async () => {
  const { fetchRecentMemories } = await featureModule;
  const original = globalThis.fetch, signal = new AbortController().signal;
  let calls = 0;
  try {
    globalThis.fetch = async (url, options) => {
      calls++;
      assert.equal(url, 'https://api.example.test/api/entries/pixel-art/recent?as_of=2026-11-19');
      assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'include');
      assert.equal(options.headers['X-AuraJournal-CSRF'], '1'); assert.equal(options.signal, signal);
      return new Response('[]');
    };
    assert.deepEqual(await fetchRecentMemories('2026-11-19', { signal }), []);
    await assert.rejects(fetchRecentMemories('bad-date'));
    assert.equal(calls, 1);
    for (const body of ['{}', 'null', '<html>proxy error</html>']) {
      globalThis.fetch = async () => new Response(body);
      await assert.rejects(fetchRecentMemories('2026-11-19'));
    }
  } finally { globalThis.fetch = original; }
});

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
  const { apiPng, fetchRecentMemories, pixelMemoryError } = await featureModule;
  const original = globalThis.fetch, oldWindow = globalThis.window, events = [];
  globalThis.window = { dispatchEvent: event => events.push(event.type) };
  try {
    for (const status of [401, 403, 404, 429, 503, 504]) {
      let calls = 0;
      globalThis.fetch = async () => { calls++; return new Response('{"detail":"private internal detail"}', { status }); };
      for (const request of [() => apiPng(record(entry(1)).image.content_url), () => fetchRecentMemories('2026-11-19')]) {
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

test('metadata lifecycle recovers only on explicit retry and rejects stale navigation and account results', async () => {
  const { createMemoriesLoader } = await featureModule;
  const session = sessionFixture(), changes = [], requests = [];
  const loader = createMemoriesLoader({ ...session, onChange: state => changes.push(state),
    request: (asOf, options) => { const held = deferred(); requests.push({ asOf, ...options, ...held }); return held.promise; } });
  const first = loader.load('2026-11-19'), second = loader.load('2026-11-12');
  assert.equal(requests[0].signal.aborted, true);
  requests[1].resolve([]); await second;
  requests[0].resolve([record(entry(1))]); await first;
  assert.deepEqual(changes.at(-1), { status: 'ready', records: [] });
  const third = loader.load('2026-11-19'); session.change();
  requests[2].resolve([record(entry(1))]); await third;
  assert.equal(changes.at(-1).status, 'expired');
  assert.equal(session.listeners.size, 0);
  loader.cancel();
  let calls = 0;
  const retry = createMemoriesLoader({ ...session, onChange: state => changes.push(state), request: async () => {
    if (++calls === 1) throw new TypeError('Network lost'); return [];
  } });
  await retry.load('2026-11-19'); assert.equal(changes.at(-1).status, 'error'); assert.equal(calls, 1);
  await retry.load('2026-11-19'); assert.equal(changes.at(-1).status, 'ready'); assert.equal(calls, 2);
  session.change(); assert.equal(changes.at(-1).status, 'expired'); // Also clear completed metadata.
  retry.cancel();
});

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

test('UI distinguishes no journal, saved journal without image, unknown metadata and loading journals', async () => {
  const { MemoryDays, PixelMemories } = await featureModule;
  const rows = [entry(1)], days = mapPixelMemories(rows, [], '2026-11-19').days;
  const html = render(MemoryDays, { days, status: 'ready' });
  assert.equal((html.match(/data-memory-date=/g) || []).length, 7);
  assert.equal((html.match(/>No journal</g) || []).length, 6);
  assert.match(html, /No pixel image yet/); assert.match(html, /Journal saved/);
  assert.match(html, new RegExp(`href="/journal/${id(1)}"`));
  const pending = render(MemoryDays, { days, status: 'loading' });
  assert.match(pending, /Looking for images/); assert.doesNotMatch(pending, /No pixel image yet/);
  const failed = render(MemoryDays, { days, status: 'error' });
  assert.match(failed, /Images unavailable/); assert.doesNotMatch(failed, /No pixel image yet/);
  const base = { entries: rows, todayKey: '2026-11-19', userId: 'a', timezone: 'UTC' };
  const loading = render(PixelMemories, { ...base, status: 'loading' });
  assert.equal((loading.match(/data-memory-date=/g) || []).length, 7);
  assert.match(loading, /Loading journals/); assert.doesNotMatch(loading, /Fictional memory|No journal</);
  const failure = render(PixelMemories, { ...base, status: 'error' });
  assert.match(failure, /Use Refresh memories/); assert.doesNotMatch(failure, /Fictional memory|No journal</);
  assert.match(render(PixelMemories, { ...base, entries: [], status: 'ready' }), /Gathering your stored pixel memories/);
});

test('same-day UI provides every journal link and keyboard-native image selection controls', async () => {
  const { MemoryDays } = await featureModule;
  const rows = [entry(1), entry(2), entry(3)], records = [record(rows[0], 101), record(rows[1], 102)];
  const html = render(MemoryDays, { ...mapPixelMemories(rows, records, '2026-11-19'), status: 'ready' });
  assert.match(html, /<details/); assert.match(html, /<summary>2 more journals · 1 more pixel memory/);
  for (const row of rows) assert.match(html, new RegExp(`href="/journal/${row.id}"`));
  assert.match(html, /<button type="button" aria-pressed="true"/);
  assert.match(html, /<button type="button" aria-pressed="false"/);
  assert.match(html, /Loading image/); assert.doesNotMatch(html, /src="https?:|src="\/api/);
});

// Exercise the real component effects and handlers with the repository's
// dependency-free hook harness approach. Actual browser layout is checked manually.
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

test('selecting an additional image updates both thumbnail and caption to that exact journal', async () => {
  const rows = [entry(1), entry(2)];
  const day = mapPixelMemories(rows, rows.map((row, i) => record(row, 100 + i)), '2026-11-19').days.at(-1);
  const f = await interaction('MemoryDay', { day, status: 'ready' });
  let image = f.nodes().find(node => node.type.name === 'MemoryImage');
  const other = rows.find(row => row.id !== image.props.memory.entry_id);
  const buttons = f.nodes().filter(node => node.type === 'button');
  assert.equal(buttons.length, 2); buttons.find(node => node.props['aria-pressed'] === false).props.onClick(); f.update();
  image = f.nodes().find(node => node.type.name === 'MemoryImage');
  assert.equal(image.props.memory.entry_id, other.id);
  const caption = f.nodes().find(node => node.props.className === 'pixel-memory-caption');
  assert.equal(caption.props.to, `/journal/${other.id}`);
  // Deleted or moved selected entry falls back to an image that still belongs to this day.
  const remaining = rows.filter(row => row.id !== other.id);
  f.update({ day: mapPixelMemories(remaining, [record(remaining[0])], '2026-11-19').days.at(-1), status: 'ready' });
  assert.equal(f.nodes().find(node => node.type.name === 'MemoryImage').props.memory.entry_id, remaining[0].id);
  f.unmount();
});

test('end-date control follows midnight, rejects invalid/future input, and resets historical selection', async () => {
  const base = { entries: [], status: 'ready', todayKey: '2027-01-01', userId: 'a', timezone: 'UTC', onRefresh() {} };
  const f = await interaction('PixelMemories', base);
  const picker = () => f.nodes().find(node => node.type === 'input');
  assert.equal(picker().props.value, '2027-01-01');
  f.update({ ...base, todayKey: '2027-01-02' }); assert.equal(picker().props.value, '2027-01-02');
  picker().props.onChange({ target: { value: '2026-12-25' } }); f.update(); assert.equal(picker().props.value, '2026-12-25');
  for (const value of ['', '2026-02-30', '2027-01-03', '1000-01-01']) {
    picker().props.onChange({ target: { value } }); f.update(); assert.equal(picker().props.value, '2026-12-25');
  }
  const historicalKey = f.nodes().find(node => node.type.name === 'MemoriesGallery').key;
  f.update({ ...base, todayKey: '2027-01-02', userId: 'b' });
  assert.notEqual(f.nodes().find(node => node.type.name === 'MemoriesGallery').key, historicalKey);
  f.nodes().find(node => node.type === 'button' && node.props.children === 'Today').props.onClick(); f.update();
  assert.equal(picker().props.value, '2027-01-02'); f.unmount();
});

test('real image component renders a fetched object URL, retries failed decode and cleans up', async () => {
  const originalFetch = globalThis.fetch, oldCreate = URL.createObjectURL, oldRevoke = URL.revokeObjectURL;
  const created = [], revoked = []; let calls = 0, f;
  try {
    globalThis.fetch = async () => { calls++; return new Response(png()); };
    URL.createObjectURL = () => { const url = `blob:fixture-${created.length}`; created.push(url); return url; };
    URL.revokeObjectURL = url => revoked.push(url);
    f = await interaction('MemoryImage', { memory: { ...record(entry(1)), entry: entry(1) }, label: 'November 19' });
    await settleView(f, nodes => nodes.some(node => node.type === 'img'));
    const image = f.nodes().find(node => node.type === 'img');
    assert.equal(image.props.src, created[0]); assert.equal(image.props.width, 128); assert.equal(calls, 1);
    image.props.onError(); f.update(); assert.deepEqual(revoked, created);
    f.nodes().find(node => node.type === 'button').props.onClick(); f.update();
    await settleView(f, nodes => nodes.some(node => node.type === 'img')); assert.equal(calls, 2);
    f.module.changeAuthEpoch(); f.update();
    assert.ok(!f.nodes().some(node => node.type === 'img')); assert.deepEqual(revoked, created);
    f.unmount(); assert.deepEqual(revoked, created);
  } finally { f?.unmount(); globalThis.fetch = originalFetch; URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke; }
});

test('gallery empty, error, malformed metadata and retry states preserve all seven dates', async () => {
  const original = globalThis.fetch; let calls = 0, f, refreshed = 0;
  try {
    globalThis.fetch = async () => {
      calls++;
      return calls === 1 ? new Response('{"detail":"unavailable"}', { status: 503 })
        : new Response(JSON.stringify(calls === 2 ? [] : [null]));
    };
    f = await interaction('MemoriesGallery', { entries: [], asOf: '2026-11-19', onRefresh() { refreshed++; } });
    await settleView(f, nodes => nodes.some(node => node.props.role === 'alert'));
    assert.equal(calls, 1);
    assert.match(f.nodes().find(node => node.props.role === 'alert').props.children[0], /temporarily unavailable/);
    f.update(); assert.equal(calls, 1); // Rendering does not retry.
    f.nodes().find(node => node.type === 'button').props.onClick(); f.update();
    await settleView(f, nodes => nodes.some(node => node.props.role === 'status' && String(node.props.children).includes('No journals')));
    assert.equal(calls, 2);
    const days = () => f.nodes().find(node => node.type.name === 'MemoryDays');
    assert.equal(days().props.days.length, 7);
    f.module.changeAuthEpoch(); f.update();
    assert.equal(days().props.status, 'expired');
    f.unmount();
    f = await interaction('MemoriesGallery', { entries: [entry(1)], asOf: '2026-11-19', onRefresh() { refreshed++; } });
    await settleView(f, nodes => nodes.some(node => node.type === 'button'));
    assert.equal(calls, 3);
    f.nodes().find(node => node.type === 'button').props.onClick(); assert.equal(refreshed, 1);
    assert.equal(calls, 3); f.unmount();
    globalThis.fetch = async () => new Response('[]');
    f = await interaction('MemoriesGallery', { entries: [entry(1)], asOf: '2026-11-19' });
    await settleView(f, nodes => nodes.some(node => node.props.role === 'status' && String(node.props.children).includes('No pixel images')));
    assert.equal(f.nodes().find(node => node.type.name === 'MemoryDays').props.days.at(-1).entries.length, 1);
  } finally { f?.unmount(); globalThis.fetch = original; }
});

test('image 404 retains the correct journal link and explicit retry can recover', async () => {
  const original = globalThis.fetch, oldCreate = URL.createObjectURL, oldRevoke = URL.revokeObjectURL;
  let calls = 0, f;
  try {
    globalThis.fetch = async () => ++calls === 1 ? new Response('', { status: 404 }) : new Response(png());
    URL.createObjectURL = () => 'blob:recovered'; URL.revokeObjectURL = () => {};
    f = await interaction('MemoryImage', { memory: { ...record(entry(1)), entry: entry(1) }, label: 'November 19' });
    await settleView(f, nodes => nodes.some(node => node.type === 'button'));
    assert.equal(f.nodes().find(node => node.props.className === 'pixel-memory-art').props.to, `/journal/${id(1)}`);
    assert.match(f.nodes().find(node => node.type === 'p').props.children, /no longer available/);
    assert.equal(calls, 1);
    f.nodes().find(node => node.type === 'button').props.onClick(); f.update();
    await settleView(f, nodes => nodes.some(node => node.type === 'img'));
    assert.equal(calls, 2); f.unmount();
  } finally { f?.unmount(); globalThis.fetch = original; URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke; }
});

test('metadata deadline is recoverable and Strict Mode cleanup permits a fresh request', async () => {
  const { createMemoriesLoader } = await featureModule;
  const oldSet = globalThis.setTimeout, oldClear = globalThis.clearTimeout;
  const session = sessionFixture(), states = [], requests = [];
  let timeout;
  globalThis.setTimeout = callback => { timeout = callback; return 1; };
  globalThis.clearTimeout = () => {};
  const loader = createMemoriesLoader({ ...session, onChange: state => states.push(state),
    request: (asOf, options) => { const held = deferred(); requests.push({ ...held, ...options }); return held.promise; } });
  try {
    const initial = loader.load('2026-11-19'); loader.cancel(); // Strict Mode's first cleanup.
    const active = loader.load('2026-11-19'); timeout();
    assert.equal(states.at(-1).status, 'error'); assert.match(states.at(-1).error, /timed out/);
    assert.equal(requests[1].signal.aborted, true);
    requests[0].resolve([record(entry(1))]); requests[1].resolve([record(entry(1))]); await Promise.all([initial, active]);
    assert.equal(states.at(-1).status, 'error');
    const retry = loader.load('2026-11-19'); requests[2].resolve([]); await retry;
    assert.equal(states.at(-1).status, 'ready');
  } finally { loader.cancel(); globalThis.setTimeout = oldSet; globalThis.clearTimeout = oldClear; }
});

test('gallery styles preserve crisp 128px art, native focus visibility and a contained mobile scroller', async () => {
  const css = await readFile(resolve(feature, 'pixelMemories.css'), 'utf8');
  assert.match(css, /image-rendering: pixelated/); assert.match(css, /width: 128px; height: 128px/);
  assert.match(css, /overflow-x: auto/); assert.match(css, /grid-template-columns: repeat\(7,/);
  assert.match(css, /:focus-visible/); assert.match(css, /@media \(max-width: 600px\)/);
  assert.doesNotMatch(css, /animation:|scroll-behavior: smooth/);
});
