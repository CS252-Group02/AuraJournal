import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { DAILY_REFLECTIONS, dailyReflection } from '../src/frontend/src/features/journal/homeContent.js';
import { groupEntriesByDay, currentStreak } from '../src/frontend/src/features/calendar/calendarModel.js';
import { readLocalDay } from '../src/frontend/src/lib/useLocalDay.js';
import { toDateKey } from '../src/frontend/src/lib/localDate.js';

const entry = (id, day, content = `Journal ${id}. A little moment to remember.`) => ({ id, content,
  created_at: new Date(2026, 10, day, 12).toISOString(), ai_summary: null });

test('daily reflections are deterministic, unattributed, and depend on calendar dates rather than render time', () => {
  assert.ok(DAILY_REFLECTIONS.length >= 5);
  const first = dailyReflection('2026-11-16');
  for (let i = 0; i < 100; i++) assert.equal(dailyReflection('2026-11-16'), first);
  assert.notEqual(dailyReflection('2026-11-17'), first);
  assert.equal(dailyReflection('2026-11-23'), first);
  for (const key of ['2024-02-29', '2026-03-08', '2026-11-01', '2026-12-31', '2027-01-01']) {
    assert.ok(DAILY_REFLECTIONS.includes(dailyReflection(key)));
  }
  assert.equal(dailyReflection('invalid'), DAILY_REFLECTIONS[0]);
});

test('shared clock supplies the same local date key and browser timezone used by Dashboard', () => {
  const clock = readLocalDay();
  assert.equal(clock.todayKey, toDateKey(new Date()));
  assert.equal(clock.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
});

test('shared clock reads a new local day at midnight, including leap day and year boundaries', context => {
  context.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 11, 31, 23, 59, 59) });
  assert.equal(readLocalDay().todayKey, '2026-12-31');
  context.mock.timers.setTime(new Date(2027, 0, 1, 0, 0, 1).getTime());
  assert.equal(readLocalDay().todayKey, '2027-01-01');
  context.mock.timers.setTime(new Date(2024, 1, 29, 12).getTime());
  assert.equal(readLocalDay().todayKey, '2024-02-29');
  context.mock.timers.reset();
});

test('Home activity uses existing distinct-day streak rules, including yesterday and gaps', () => {
  const today = new Date(2026, 10, 16);
  let index = groupEntriesByDay([entry('today', 16), entry('again', 16), entry('yesterday', 15), entry('earlier', 14)]);
  assert.deepEqual(currentStreak(index.byDay, today), { count: 3, throughKey: '2026-11-16' });
  index = groupEntriesByDay([entry('yesterday', 15), entry('earlier', 14), entry('gap', 12)]);
  assert.deepEqual(currentStreak(index.byDay, today), { count: 2, throughKey: '2026-11-15' });
  assert.equal(currentStreak(groupEntriesByDay([entry('old', 12)]).byDay, today).count, 0);
  assert.equal(currentStreak(new Map(), today).count, 0);
});

async function loadComponents() {
  const result = await build({
    stdin: { contents: 'export { default as Home } from "./pages/JournalPage.jsx"; export { default as Preview } from "./features/calendar/CalendarPreview.jsx";',
      resolveDir: fileURLToPath(new URL('../src/frontend/src/', import.meta.url)), loader: 'jsx' },
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic',
    plugins: [{ name: 'home-context', setup(builder) {
      builder.onLoad({ filter: /[\\/]auth[\\/]Auth\.jsx$/ }, () => ({
        contents: 'export const useAuth = () => globalThis.__homeAuth;', loader: 'js',
      }));
      builder.onLoad({ filter: /useJournalEntries\.js$/ }, () => ({
        contents: 'export const useJournalEntries = () => globalThis.__homeEntries;', loader: 'js',
      }));
      builder.onLoad({ filter: /useLocalDay\.js$/ }, () => ({
        contents: 'export const useLocalDay = () => ({todayKey: "2026-11-16", timezone: "Asia/Ho_Chi_Minh"});', loader: 'js',
      }));
      builder.onLoad({ filter: /[\\/]lib[\\/]api\.js$/ }, () => ({
        contents: 'export const api = () => { throw new Error("No requests during render"); };', loader: 'js',
      }));
    } }],
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  return module.exports;
}
const components = loadComponents();
const render = (Component, props = {}) => renderToStaticMarkup(React.createElement(MemoryRouter, {}, React.createElement(Component, props)));
function setup(entries = [], status = 'ready', error = '') {
  globalThis.__homeAuth = { user: { id: 'home-user', email: 'journal@example.test' }, logout() {} };
  globalThis.__homeEntries = { entries, status, error, reload() {}, setEntries() {} };
}

test('calendar preview has real counts, today, and direct/single versus Dashboard/multiple links', async () => {
  const { Preview } = await components;
  const index = groupEntriesByDay([entry('single', 16), entry('a', 15), entry('b', 15)]);
  const html = render(Preview, { todayKey: '2026-11-16', byDay: index.byDay, status: 'ready' });
  assert.match(html, /November 2026/);
  assert.match(html, /aria-current="date"/);
  assert.match(html, /href="\/journal\/single"/);
  assert.match(html, /href="\/dashboard\?month=2026-11&amp;date=2026-11-15"/);
  assert.match(html, /November 15, 2026, 2 journals/);
  assert.equal((html.match(/home-calendar-day/g) || []).length, 30);
  assert.equal((html.match(/class="home-activity-dot"/g) || []).length, 3); // Two dates and the legend.
  assert.doesNotMatch(html, /role="grid"|Heatmap|Previous month|mood unavailable/);
});

test('preview does not expose stale activity or entry links during loading and errors', async () => {
  const { Preview } = await components;
  for (const status of ['loading', 'error']) {
    const html = render(Preview, { todayKey: '2026-11-16', byDay: groupEntriesByDay([entry('private', 16)]).byDay, status });
    assert.match(html, /activity unavailable/);
    assert.match(html, /aria-current="date"/);
    assert.doesNotMatch(html, /href="\/journal\/|has-entries/);
  }
});

test('Home welcomes the real account, links to existing routes, and shows three API-ordered journals', async () => {
  const { Home } = await components;
  setup([entry('newest', 16), entry('second', 15), entry('third', 14), entry('fourth', 13)]);
  const html = render(Home);
  for (const route of ['/record', '/dashboard', '/history', '/reflection', '/journal/newest', '/journal/second', '/journal/third']) {
    assert.ok(html.includes(`href="${route}"`), route);
  }
  assert.doesNotMatch(html.slice(html.indexOf('class="home-recent"')), /href="\/journal\/fourth"/);
  assert.match(html, /journal@example.test/);
  assert.match(html, /Your account/);
  assert.match(html, /Log out/);
  assert.match(html, /A 4-day journaling rhythm/);
  assert.match(html, /Write instead/);
  assert.match(html, /aria-expanded="false" aria-controls="home-writing"/);
  assert.match(html, /dateTime="2026-11-16"|datetime="2026-11-16"/);
  assert.doesNotMatch(html, /Delete entry|Edit entry|<textarea|<audio|Settings|Music Player/);
});

test('empty Home encourages a first entry without invented activity or streaks', async () => {
  const { Home } = await components;
  setup();
  const html = render(Home);
  assert.match(html, /Your story starts wherever you are/);
  assert.match(html, /A fresh page whenever you’re ready/);
  assert.match(html, /View all entries/);
  assert.doesNotMatch(html, /-day journaling rhythm|has-entries/);
});

test('Home loading and failures remain distinct from an empty account, with recording/writing always reachable', async () => {
  const { Home } = await components;
  setup([entry('stale', 16)], 'loading');
  const loading = render(Home);
  assert.match(loading, /Gathering your moments/);
  assert.doesNotMatch(loading, /-day journaling rhythm|Your story starts|\/journal\/stale/);
  setup([entry('stale', 16)], 'error', 'The connection is unavailable.');
  const error = render(Home);
  assert.match(error, /role="alert"/);
  assert.match(error, /Try again/);
  assert.match(error, /The connection is unavailable/);
  assert.match(error, /href="\/record"/);
  assert.match(error, /Write instead/);
  assert.doesNotMatch(error, /-day journaling rhythm|Your story starts|\/journal\/stale/);
});

test('invalid dates retain journal access and another account never inherits the previous previews', async () => {
  const { Home } = await components;
  setup([{ ...entry('undated', 16), created_at: 'not-a-date' }]);
  const html = render(Home);
  assert.match(html, /Some entry dates are unavailable/);
  assert.match(html, /href="\/journal\/undated"/);
  setup();
  globalThis.__homeAuth = { user: { id: 'different', email: 'other@example.test' }, logout() {} };
  const other = render(Home);
  assert.match(other, /other@example.test/);
  assert.doesNotMatch(other, /journal@example.test|undated/);
});
