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
  monthlyActivity, moodAnalytics, reflectionScope, weeklyActivity } from '../src/frontend/src/features/dashboard/dashboardModel.js';
import { groupEntriesByDay } from '../src/frontend/src/features/calendar/calendarModel.js';

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
  assert.deepEqual(summary, { total: 7, activeDays: 4, todayCount: 0, current: { count: 3, throughKey: '2027-01-01' }, longest: 3, monthDays: 1 });
  const empty = activitySummary([], new Map(), '2027-01-02', '2026-12');
  assert.equal(empty.longest, 0);
  assert.equal(empty.current.count, 0);
  const leap = ['2024-02-28', '2024-02-29', '2024-03-01'].map((day, i) => row(i, day));
  assert.equal(activitySummary(leap, indexJournalDays(leap).byDay, '2024-03-01', '2024-02').longest, 3);
});

test('Dashboard and Calendar share one day index without mutating entries or moving saved dates', () => {
  assert.equal(indexJournalDays, groupEntriesByDay);
  const entries = Object.freeze([Object.freeze(row('backdated', '2024-02-29', { created_at: '2026-11-19T12:00:00Z' })),
    Object.freeze(row('invalid', '2026-02-30')), Object.freeze({ id: 'legacy', created_at: '2026-11-19T12:00:00Z' })]);
  assert.deepEqual(indexJournalDays(entries), groupEntriesByDay(entries));
  assert.equal(indexJournalDays(entries).invalidCount, 1);
});

test('frontend streaks match the documented backend calendar samples at the same as_of date', () => {
  const samples = [
    { dates: ['2026-10-30', '2026-10-31', '2026-10-31', '2026-11-01', '2026-11-03', '2024-02-28', '2024-02-29', '2024-03-01'], expected: [3, 3, 1, 0], leap: 3 },
    { dates: ['2026-10-31', '2026-11-02', '2026-11-03', '2024-03-01'], expected: [1, 1, 2, 0], leap: 1 },
  ];
  for (const sample of samples) {
    const entries = sample.dates.map((day, index) => row(String(index), day));
    const byDay = indexJournalDays(entries).byDay;
    const actual = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-05']
      .map(day => activitySummary(entries, byDay, day).current.count);
    assert.deepEqual(actual, sample.expected);
    assert.equal(activitySummary(entries, byDay, '2024-03-01').current.count, sample.leap);
  }
});

test('monthly overview counts all saved dates, handles ties deterministically and keeps future activity separate', () => {
  const entries = [row('late', '2026-11-12'), row('early', '2026-11-01'), row('late-again', '2026-11-12'),
    row('early-again', '2026-11-01'), row('future', '2026-11-30'), row('previous', '2026-10-01')];
  const byDay = indexJournalDays(entries).byDay;
  const month = monthlyActivity(byDay, '2026-11', '2026-11-19');
  assert.equal(month.count, 5);
  assert.equal(month.activeDays, 3);
  assert.equal(month.futureCount, 1);
  assert.deepEqual(month.mostActive, { key: '2026-11-01', count: 2, tiedDays: 2 });
  assert.deepEqual(month.comparison, { previousMonth: '2026-10', throughDay: 19, currentCount: 4, previousCount: 1, delta: 3 });
  assert.equal(monthlyActivity(byDay, '2026-12', '2026-11-19').comparison, null);
  assert.equal(monthlyActivity(new Map(), '2026-11', '2026-11-19').mostActive, null);
});

test('monthly comparisons use equal elapsed days through short months and whole historical months', () => {
  for (const [year, last] of [[2024, 29], [2026, 28]]) {
    const entries = [row('feb', `${year}-02-${last}`), row('march', `${year}-03-${last}`),
      row('outside', `${year}-03-31`), row('april', `${year}-04-01`)];
    const byDay = indexJournalDays(entries).byDay;
    const current = monthlyActivity(byDay, `${year}-03`, `${year}-03-31`);
    assert.equal(current.count, 2);
    assert.equal(current.comparison.throughDay, last);
    assert.equal(current.comparison.currentCount, 1);
    assert.equal(current.comparison.previousCount, 1);
    assert.equal(current.comparison.delta, 0);
    const historical = monthlyActivity(byDay, `${year}-03`, `${year}-04-15`);
    assert.equal(historical.comparison.throughDay, null);
    assert.equal(historical.comparison.delta, 1);
  }
  const byDay = indexJournalDays([row('december', '2025-12-01'), row('january', '2026-01-01')]).byDay;
  assert.equal(monthlyActivity(byDay, '2026-01', '2026-01-01').comparison.previousMonth, '2025-12');
});

test('reloading edited, moved or deleted entries rebuilds heatmap, monthly highlights and streaks', () => {
  const original = [row('a', '2024-02-28'), row('b', '2024-02-29'), row('c', '2024-03-01')];
  const moved = original.map(entry => entry.id === 'b' ? { ...entry, journal_date: '2024-03-01' } : entry);
  const deleted = moved.filter(entry => entry.id !== 'a');
  for (const [entries, longest, februaryDays, marchCount] of [[original, 3, 2, 1], [moved, 1, 1, 2], [deleted, 1, 0, 2]]) {
    const byDay = indexJournalDays(entries).byDay;
    assert.equal(activitySummary(entries, byDay, '2024-03-01', '2024-03').longest, longest);
    assert.equal(monthlyActivity(byDay, '2024-02', '2024-03-01').activeDays, februaryDays);
    assert.equal(monthlyActivity(byDay, '2024-03', '2024-03-01').count, marchCount);
  }
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
      builder.onLoad({ filter: /[\\/]auth[\\/]Auth.jsx$/ }, () => ({ contents: 'export const useAuth=()=>({user:globalThis.__dashboardUser||{id:"account-a",email:"a@example.com"}});', loader: 'js' }));
      builder.onLoad({ filter: /useLocalDay.js$/ }, () => ({ contents: 'export const useLocalDay=()=>({todayKey:"2026-11-19",timezone:"UTC",refresh:()=>({todayKey:"2026-11-19"})});', loader: 'js' }));
      builder.onLoad({ filter: /useJournalEntries.js$/ }, () => ({ contents: 'export const useJournalEntries=()=>globalThis.__dashboardEntries;', loader: 'js' }));
      builder.onLoad({ filter: /[\\/]lib[\\/]api.js$/ }, () => ({ contents: 'export const api=(...args)=>globalThis.__dashboardApi(...args); export const apiPng=api; export const getAuthEpoch=()=>0; export const subscribeAuthChanges=()=>()=>{};', loader: 'js' }));
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
  for (const text of ['Current streak', 'Longest streak', 'Journal entries', 'A week in moments', 'Moments in Pixels', 'Your moods, gently noticed', 'Recent memories', 'Your journal companion']) assert.ok(html.includes(text), text);
  assert.equal((html.match(/data-memory-date=/g) || []).length, 7);
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
  assert.match(html, /1 classified · 1 without a mood/);
  assert.match(html, /#ddeadc/);
  assert.match(html, /Daily mood history/);
});

test('monthly overview renders real totals, comparison bounds, tied dates and transparent future activity', async () => {
  const { MonthlyOverview } = await components;
  const byDay = indexJournalDays([row('a', '2026-11-01'), row('b', '2026-11-01'), row('c', '2026-11-12'),
    row('d', '2026-11-12'), row('future', '2026-11-30'), row('previous', '2026-10-01')]).byDay;
  const props = { month: new Date(2026, 10, 1), summary: monthlyActivity(byDay, '2026-11', '2026-11-19'), status: 'ready' };
  const html = render(MonthlyOverview, props);
  assert.match(html, /November 2026, in moments/);
  assert.match(html, /<strong>5<\/strong> entries across <strong>3<\/strong> journal days/);
  assert.match(html, /2 dates tied; earliest shown/);
  assert.match(html, /3 entries more.*October 2026/);
  assert.match(html, /first 19 days of each month/);
  assert.match(html, /Includes 1 entry dated after today/);
  for (const status of ['loading', 'error']) {
    const pending = render(MonthlyOverview, { ...props, status });
    assert.doesNotMatch(pending, /<strong>|Most entries on|entries more|dates tied/);
    assert.match(pending, /role="status"/);
  }
  const empty = render(MonthlyOverview, { ...props, summary: monthlyActivity(new Map(), '2026-11', '2026-11-19') });
  assert.match(empty, /No journals this month/);
  assert.doesNotMatch(empty, /Most entries on/);
});

test('overview statistics separate all-time days, monthly activity and factual today highlights', async () => {
  const { DashboardPage } = await components;
  globalThis.__dashboardEntries = { entries: [row('old', '2026-10-01'), row('yesterday', '2026-11-18'),
    row('today', '2026-11-19'), row('today-again', '2026-11-19'), row('future', '2026-12-01')], status: 'ready', reload() {} };
  const html = render(DashboardPage, {}, '/dashboard?month=2026-10');
  assert.match(html, /Days journaled<\/dt><dd>3<span> through today/);
  assert.match(html, /Journal entries<\/dt><dd>5/);
  assert.match(html, /2 entries are dated today/);
  assert.match(html, /· UTC/);
  assert.match(html, /October 2026, in moments/);
  assert.match(html, /<strong>1<\/strong> entry across <strong>1<\/strong> journal day/);
  assert.match(html, /Mood unavailable/);
  assert.doesNotMatch(html, /Most recorded:/);
});

test('stale data stays hidden during reload/errors and another account cannot inherit highlights or links', async () => {
  const { DashboardPage } = await components;
  const entries = [row('private-draft', '2026-11-19')];
  for (const status of ['loading', 'error']) {
    globalThis.__dashboardEntries = { entries, status, error: 'Please log in.', reload() {} };
    const html = render(DashboardPage, {}, '/dashboard?month=2026-11&date=2026-11-19');
    assert.doesNotMatch(html, /\/journal\/private-draft|1 entry is dated today|Most entries on|Generate weekly recap|Memory private-draft/);
    assert.match(html, /Loading your journal activity|Please log in/);
  }
  try {
    globalThis.__dashboardUser = { id: 'other-account', email: 'other@example.test' };
    globalThis.__dashboardEntries = { entries: [], status: 'ready', reload() {} };
    const other = render(DashboardPage, {}, '/dashboard?month=2026-11&date=2026-11-19');
    assert.match(other, /No journals yet/);
    assert.match(other, /No journals on this date/);
    assert.doesNotMatch(other, /private-draft|Most entries on|Generate weekly recap/);
  } finally { delete globalThis.__dashboardUser; }
});

test('missing mood scores never acquire categories in analytics or recent entries', async () => {
  const { MoodAnalytics, RecentEntries } = await components;
  const entries = [row('numeric', '2026-11-19', { valence: 0.9, arousal: 0.1, mood_record: { valence: 0.9, arousal: 0.1 } })];
  const moods = render(MoodAnalytics, { byDay: indexJournalDays(entries).byDay, todayKey: '2026-11-19', status: 'ready' });
  assert.match(moods, /Mood data isn’t available/);
  assert.doesNotMatch(moods, /Most recorded:|Daily mood history/);
  const recent = render(RecentEntries, { entries, status: 'ready' });
  assert.match(recent, /Mood unavailable/);
  assert.doesNotMatch(recent, />Calm<|>Happy<|>Blue<|0\.9/);
});
