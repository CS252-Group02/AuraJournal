import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { activitySummary, companionMessage, dashboardPreview, indexJournalDays, journalDayKey,
  moodAnalytics, reflectionScope, weeklyActivity } from '../src/frontend/src/features/dashboard/dashboardModel.js';

const row = (id, day, extra = {}) => ({ id, journal_date: day, created_at: `${day}T12:00:00Z`, content: `Memory ${id}. A small moment.`, ...extra });

test('journal dates take precedence and malformed supplied dates never silently move an entry', () => {
  const backdated = row('backdated', '2026-02-28', { created_at: '2026-03-01T23:30:00Z' });
  assert.equal(journalDayKey(backdated), '2026-02-28');
  assert.equal(journalDayKey({ journal_date: '2024-02-29' }), '2024-02-29');
  for (const value of ['2026-02-29', '2026-13-01', '2026-02-28T12:00:00Z', '']) {
    assert.equal(journalDayKey({ ...backdated, journal_date: value }), null);
  }
  assert.equal(journalDayKey({ created_at: null }), null);
  assert.equal(journalDayKey({ created_at: 'invalid' }), null);
  const entries = Object.freeze([backdated, row('same', '2026-02-28'), { id: 'invalid' }]);
  const { byDay, invalidCount } = indexJournalDays(entries);
  assert.deepEqual(byDay.get('2026-02-28'), entries.slice(0, 2));
  assert.equal(invalidCount, 1);
});

test('date-only grouping is stable across timezones and timestamp fallback honors local midnight and DST', () => {
  const url = new URL('../src/frontend/src/features/dashboard/dashboardModel.js', import.meta.url).href;
  const source = `import {journalDayKey,indexJournalDays,activitySummary} from ${JSON.stringify(url)};
    const rows=['2026-03-07','2026-03-08','2026-03-09'].map((day,i)=>({id:i,journal_date:day}));
    const byDay=indexJournalDays(rows).byDay;
    console.log(JSON.stringify({fixed:journalDayKey({journal_date:'2026-01-01',created_at:'2026-01-01T00:30:00Z'}),
      fallback:journalDayKey({created_at:'2026-01-01T00:30:00Z'}),
      streak:activitySummary(rows,byDay,'2026-03-09','2026-03').longest}));`;
  for (const [timezone, fallback] of [['UTC', '2026-01-01'], ['Asia/Ho_Chi_Minh', '2026-01-01'], ['America/New_York', '2025-12-31']]) {
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', env: { ...process.env, TZ: timezone } }));
    assert.deepEqual(result, { fixed: '2026-01-01', fallback, streak: 3 });
  }
});

test('streaks count distinct days through yesterday across years, while totals retain undated and future journals', () => {
  const entries = [row('a', '2026-12-30'), row('b', '2026-12-31'), row('c', '2027-01-01'), row('d', '2027-01-01'),
    row('future', '2027-01-03'), row('old', '2026-05-01'), { id: 'undated' }];
  const summary = activitySummary(entries, indexJournalDays(entries).byDay, '2027-01-02', '2027-01');
  assert.deepEqual(summary, { total: 7, current: { count: 3, throughKey: '2027-01-01' }, longest: 3, monthDays: 1 });
  const empty = activitySummary([], new Map(), '2027-01-02', '2026-12');
  assert.equal(empty.longest, 0);
  assert.equal(empty.current.count, 0);
  const leap = ['2024-02-28', '2024-02-29', '2024-03-01'].map((day, i) => row(i, day));
  assert.equal(activitySummary(leap, indexJournalDays(leap).byDay, '2024-03-01', '2024-02').longest, 3);
});

test('weekly recap compares equal elapsed portions and keeps future sources separate from activity', () => {
  // Wednesday January 1: this Monday is in the previous year.
  const entries = [row('a', '2024-12-30'), row('b', '2025-01-01'), row('c', '2025-01-01'),
    row('previous', '2024-12-25'), row('later-last-week', '2024-12-27'), row('future', '2025-01-03')];
  const week = weeklyActivity(indexJournalDays(entries).byDay, '2025-01-01');
  assert.equal(week.startKey, '2024-12-30');
  assert.equal(week.count, 3);
  assert.equal(week.activeDays, 2);
  assert.deepEqual(week.previous, { count: 1, activeDays: 1 });
  assert.equal(week.sources.length, 4);
  assert.equal(week.days[4].future, true);
  assert.equal(week.days[4].count, 0);
  const monday = weeklyActivity(indexJournalDays(entries).byDay, '2024-12-30');
  assert.equal(monday.count, 1);
  assert.equal(monday.previous.count, 0);
});

test('reflection scope invalidates account, timezone, date, source edits and same-count substitutions', () => {
  const entries = [row('a', '2026-11-16')];
  const week = weeklyActivity(indexJournalDays(entries).byDay, '2026-11-17');
  const original = reflectionScope('account-a', week, 'UTC');
  assert.notEqual(reflectionScope('account-b', week, 'UTC'), original);
  assert.notEqual(reflectionScope('account-a', week, 'Asia/Ho_Chi_Minh'), original);
  for (const extra of [{ content: 'Edited' }, { journal_date: '2026-11-17' }, { updated_at: '2026-11-17' }, { id: 'different-entry' }]) {
    assert.notEqual(reflectionScope('account-a', { ...week, sources: [{ ...entries[0], ...extra }] }, 'UTC'), original);
  }
});

test('mood statistics require explicit categories and track missing data and tied modes without scores', () => {
  const entries = [row('a', '2026-11-17'), row('b', '2026-11-17'), row('unknown', '2026-11-16'), row('c', '2026-11-15'),
    row('older', '2026-10-20'), row('future', '2026-11-18')];
  const byDay = indexJournalDays(entries).byDay;
  const unavailable = moodAnalytics(byDay, '2026-11-17', 7);
  assert.equal(unavailable.classified, 0);
  assert.equal(unavailable.missing, 4);
  assert.deepEqual(unavailable.distribution, []);
  const moods = new Map([['a', 'calm'], ['b', 'happy'], ['c', 'happy'], ['unknown', 'toString']]);
  const result = moodAnalytics(byDay, '2026-11-17', 7, moods);
  assert.equal(result.total, 4);
  assert.equal(result.classified, 3);
  assert.equal(result.missing, 1);
  assert.deepEqual(result.mostFrequent, ['Happy']);
  assert.deepEqual(result.timeline.at(-1).moods, ['calm', 'happy']);
  assert.equal(moodAnalytics(byDay, '2026-11-17', 30).total, 5);
  assert.deepEqual(moodAnalytics(indexJournalDays(entries.slice(0, 2)).byDay, '2026-11-17', 7, moods).mostFrequent, ['Calm', 'Happy']);
});

test('Dashboard previews handle missing content, whitespace and Unicode without exposing a full journal', () => {
  assert.equal(dashboardPreview(null), '');
  assert.equal(dashboardPreview('  A\n small   memory  '), 'A small memory');
  assert.equal(dashboardPreview('🌱'.repeat(200)), `${'🌱'.repeat(150)}…`);
  assert.ok(dashboardPreview('x'.repeat(5000)).length <= 151);
  assert.match(companionMessage(0, 0, 0), /Welcome/);
  assert.match(companionMessage(10, 0, 0), /at your own pace/);
});

async function loadComponents() {
  const path = new URL('../src/frontend/src/features/dashboard/DashboardSections.jsx', import.meta.url);
  const result = await build({
    stdin: { contents: (await readFile(path, 'utf8')) + '\nexport {fetchDashboardReflection} from "./useDashboardReflection.js";\nexport {default as DashboardPage} from "../../pages/DashboardPage.jsx";', resolveDir: dirname(fileURLToPath(path)), loader: 'jsx' },
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic',
    plugins: [{ name: 'dashboard-context', setup(builder) {
      builder.onLoad({ filter: /[\\/]auth[\\/]Auth.jsx$/ }, () => ({ contents: 'export const useAuth=()=>({user:{id:"account-a",email:"a@example.com"}});', loader: 'js' }));
      builder.onLoad({ filter: /useJournalEntries.js$/ }, () => ({ contents: 'export const useJournalEntries=()=>globalThis.__dashboardEntries;', loader: 'js' }));
      builder.onLoad({ filter: /[\\/]lib[\\/]api.js$/ }, () => ({ contents: 'export const api=(...args)=>globalThis.__dashboardApi(...args);', loader: 'js' }));
    } }],
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  return module.exports;
}
const components = loadComponents();
function render(Component, props, url = '/dashboard') {
  return renderToStaticMarkup(React.createElement(MemoryRouter, { initialEntries: [url] }, React.createElement(Component, props)));
}

test('weekly AI adapter uses the existing journal-date endpoint and only sends its supported fields', async () => {
  const { fetchDashboardReflection } = await components;
  const signal = new AbortController().signal;
  let calls = 0;
  globalThis.__dashboardApi = async (path, options) => {
    calls++;
    assert.equal(path, '/api/reflections/weekly');
    assert.deepEqual(options, { method: 'POST', body: { start: '2026-11-16', timezone: 'UTC', date_basis: 'journal' }, signal });
    return { entry_count: 1, summary: 'A small moment.', highlights: [] };
  };
  assert.equal(calls, 0);
  const result = await fetchDashboardReflection('2026-11-16', 'UTC', { signal });
  assert.equal(result.entry_count, 1);
  assert.equal(calls, 1);
});

test('AI UI handles loading, source conflicts, oversized input, unavailable service, success and empty results', async () => {
  const { ReflectionBody } = await components;
  assert.match(render(ReflectionBody, { state: { status: 'loading' } }), /role="status"/);
  const conflict = render(ReflectionBody, { state: { status: 'error', code: 409, error: 'Journals changed' } });
  assert.match(conflict, /Refresh entries/);
  const tooLarge = render(ReflectionBody, { state: { status: 'error', code: 413, error: 'Too much text' } });
  assert.doesNotMatch(tooLarge, /Try again/);
  const unavailable = render(ReflectionBody, { state: { status: 'error', code: 503, error: 'Unavailable' } });
  assert.match(unavailable, /role="alert"/);
  assert.match(unavailable, /Try again/);
  const ready = render(ReflectionBody, { state: { status: 'ready', data: { entry_count: 1, summary: '<script>safe text</script>', highlights: [{ text: 'An event.', entry_ids: ['source-1'] }] } } });
  assert.match(ready, /AI-generated/);
  assert.match(ready, /An event/);
  assert.match(ready, /href="\/journal\/source-1"/);
  assert.doesNotMatch(ready, /<script>/);
  assert.match(render(ReflectionBody, { state: { status: 'ready', data: { entry_count: 0 } } }), /No entries remain/);
});

test('Recent Entries limits content, uses journal dates and preserves routes even for undated entries', async () => {
  const { RecentEntries } = await components;
  const entries = [row('id-1', '2026-11-16', { content: 'x'.repeat(5000), created_at: '2026-11-17T12:00:00Z' }),
    { id: 'undated' }, row('id-3', '2026-11-15'), row('id-4', '2026-11-14')];
  const html = render(RecentEntries, { entries, status: 'ready' });
  assert.match(html, /dateTime="2026-11-16"/i);
  assert.match(html, /Date unavailable/);
  assert.match(html, /href="\/journal\/undated"/);
  assert.match(html, /href="\/history"/);
  assert.doesNotMatch(html, /href="\/journal\/id-4"/);
  assert.doesNotMatch(html, new RegExp('x'.repeat(200)));
});

test('Dashboard shares real journal data and never generates a reflection during rendering', async () => {
  const { DashboardPage } = await components;
  globalThis.__dashboardApi = () => { throw new Error('Automatic AI generation'); };
  globalThis.__dashboardEntries = { entries: [row('one', '2026-11-16'), row('two', '2026-11-16')], status: 'ready', reload() {} };
  const html = render(DashboardPage, {}, '/dashboard?month=2026-11&date=2026-11-16');
  for (const text of ['Current streak', 'Longest streak', 'Journal entries', 'A week in moments', 'Your moods, gently noticed', 'Recent memories', 'Your journal companion']) assert.ok(html.includes(text), text);
  assert.match(html, /2 journals/);
  assert.match(html, /href="\/journal\/one"/);
  assert.doesNotMatch(html, /Most recorded:/);
  for (const status of ['loading', 'error']) {
    globalThis.__dashboardEntries = { entries: [], status, error: 'Offline', reload() {} };
    const pending = render(DashboardPage);
    assert.match(pending, /Gathering your journal activity|Unavailable until your journals/);
    assert.doesNotMatch(pending, /No current streak|No journals in this period|Generate weekly recap/);
  }
});

test('categorical mood fixtures render counts and colors without numeric emotional trends', async () => {
  const { MoodAnalytics } = await components;
  const byDay = indexJournalDays([row('one', '2026-11-17'), row('two', '2026-11-17')]).byDay;
  const html = render(MoodAnalytics, { byDay, todayKey: '2026-11-17', status: 'ready', moodsByEntry: new Map([['one', 'calm']]) });
  assert.match(html, /Most recorded:/);
  assert.match(html, /Calm/);
  assert.match(html, /1 classified · 1 without a saved mood/);
  assert.match(html, /#ddeadc/);
  assert.match(html, /Daily mood history/);
});
