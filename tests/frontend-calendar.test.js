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
import { toDateKey } from '../src/frontend/src/lib/localDate.js';
import { currentStreak, dateInMonth, groupEntriesByDay, HEATMAP, heatLevel, moodPresentation,
  monthCells, monthKey, parseMonthKey, shiftMonth } from '../src/frontend/src/features/calendar/calendarModel.js';

const entry = (id, year, month, day, extra = {}) => ({ id, content: `Entry ${id}. More about this day.`,
  created_at: new Date(year, month - 1, day, 12).toISOString(), ...extra });

test('month grid is Monday-first, padded to full weeks, and covers every real date once', () => {
  const starts = new Set();
  for (let month = 0; month < 12; month++) {
    const first = new Date(2026, month, 1), cells = monthCells(first);
    const leading = (first.getDay() + 6) % 7;
    starts.add(first.getDay());
    assert.equal(cells.length % 7, 0);
    assert.ok(cells.length >= 28 && cells.length <= 42);
    assert.ok(cells.slice(0, leading).every(cell => cell === null));
    const days = cells.filter(Boolean);
    assert.deepEqual(days.map(date => date.getDate()), Array.from({ length: new Date(2026, month + 1, 0).getDate() }, (_, i) => i + 1));
    assert.ok(days.every(date => date.getMonth() === month));
  }
  assert.equal(starts.size, 7);
  assert.equal(monthCells(new Date(2021, 1, 1)).length, 28);
  assert.equal(monthCells(new Date(2026, 7, 1)).length, 42);
});

test('leap years, century exceptions, month/year navigation and clamping are correct', () => {
  for (const [year, count] of [[2024, 29], [2028, 29], [2026, 28], [1900, 28], [2000, 29]]) {
    assert.equal(monthCells(new Date(year, 1, 1)).filter(Boolean).length, count);
  }
  assert.equal(monthKey(shiftMonth(new Date(2026, 11, 31), 1)), '2027-01');
  assert.equal(monthKey(shiftMonth(new Date(2026, 0, 31), -1)), '2025-12');
  assert.equal(toDateKey(dateInMonth(shiftMonth(new Date(2026, 0, 31), 1), 31)), '2026-02-28');
  assert.equal(toDateKey(dateInMonth(new Date(2024, 1, 1), 31)), '2024-02-29');
  for (const key of [null, '', '2026-13', '2026-00', '2026-2', '2026-02-01', 'not a month']) assert.equal(parseMonthKey(key), null);
  assert.equal(monthKey(parseMonthKey('2026-02')), '2026-02');
  assert.equal(monthKey(shiftMonth(parseMonthKey('9999-12'), 1)), '9999-12');
});

test('day grouping keeps complete entry objects, source ordering and invalid entries out of the index', () => {
  const first = Object.freeze(entry('newer', 2026, 11, 12, { ai_summary: 'A note' }));
  const second = Object.freeze(entry('older', 2026, 11, 12));
  const rows = Object.freeze([first, second, entry('other', 2026, 11, 11),
    { id: 'bad', created_at: 'invalid' }, { id: 'null', created_at: null }]);
  const { byDay, invalidCount } = groupEntriesByDay(rows);
  assert.equal(byDay.size, 2);
  assert.equal(invalidCount, 2);
  assert.deepEqual(byDay.get('2026-11-12'), [first, second]);
  assert.equal(byDay.get('2026-11-12')[0], first);
  assert.equal(byDay.get('2026-11-12')[0].ai_summary, 'A note');
  assert.equal(byDay.has('NaN-NaN-NaN'), false);
});

test('grouping follows local midnight and streaks use calendar days across DST in different timezones', () => {
  const modelUrl = new URL('../src/frontend/src/features/calendar/calendarModel.js', import.meta.url).href;
  const source = `import {groupEntriesByDay,currentStreak} from ${JSON.stringify(modelUrl)};
    const index=groupEntriesByDay([{id:'edge',created_at:'2026-01-01T00:30:00Z'}]).byDay;
    const spring=groupEntriesByDay([7,8,9].map(day=>({id:String(day),created_at:new Date(2026,2,day,12).toISOString()}))).byDay;
    const autumn=groupEntriesByDay([31,32,33].map(day=>({id:String(day),created_at:new Date(2026,9,day,12).toISOString()}))).byDay;
    console.log(JSON.stringify({key:[...index.keys()][0],spring:currentStreak(spring,new Date(2026,2,9)).count,autumn:currentStreak(autumn,new Date(2026,10,2)).count}));`;
  for (const [timezone, expected] of [['UTC', '2026-01-01'], ['Asia/Ho_Chi_Minh', '2026-01-01'], ['America/New_York', '2025-12-31']]) {
    const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, TZ: timezone }, encoding: 'utf8',
    }));
    assert.equal(result.key, expected, timezone);
    assert.equal(result.spring, 3, timezone);
    assert.equal(result.autumn, 3, timezone);
  }
});

test('current streak uses distinct active days through today or yesterday, ignores future dates and stops at gaps', () => {
  const today = new Date(2027, 0, 2);
  const rows = [entry('a', 2027, 1, 2), entry('b', 2027, 1, 2), entry('c', 2027, 1, 1), entry('d', 2026, 12, 31), entry('future', 2027, 1, 3)];
  assert.deepEqual(currentStreak(groupEntriesByDay(rows).byDay, today), { count: 3, throughKey: '2027-01-02' });
  assert.deepEqual(currentStreak(groupEntriesByDay(rows.slice(2)).byDay, today), { count: 2, throughKey: '2027-01-01' });
  assert.equal(currentStreak(groupEntriesByDay([rows[0], rows[3]]).byDay, today).count, 1);
  assert.deepEqual(currentStreak(groupEntriesByDay([rows[3], rows[4]]).byDay, today), { count: 0, throughKey: null });
  assert.equal(currentStreak(new Map(), today).count, 0);
});

test('heatmap has fixed Figma buckets; unknown moods never acquire a made-up category', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 1000].map(heatLevel), [0, 1, 2, 3, 4, 4]);
  assert.equal(heatLevel(NaN), 0);
  assert.equal(HEATMAP[4].color, '#eaa0bd');
  assert.equal(moodPresentation('calm').color, '#ddeadc');
  for (const value of [undefined, null, 'unknown', 'toString', 'sage']) assert.equal(moodPresentation(value), null);
});

test('large entry indexes retain every entry without expanding the month grid', () => {
  const rows = Array.from({ length: 20000 }, (_, i) => entry(`entry-${i}`, 2026, 11, i % 30 + 1));
  const { byDay } = groupEntriesByDay(rows);
  assert.equal(byDay.size, 30);
  assert.equal([...byDay.values()].reduce((total, day) => total + day.length, 0), rows.length);
  assert.ok(monthCells(new Date(2026, 10, 1)).length <= 42);
});

async function loadComponents() {
  const path = new URL('../src/frontend/src/pages/DashboardPage.jsx', import.meta.url);
  const result = await build({
    stdin: { contents: (await readFile(path, 'utf8')) + '\nexport {SelectedDayEntries};\nexport {default as Calendar} from "../features/calendar/Calendar.jsx";',
      resolveDir: dirname(fileURLToPath(path)), loader: 'jsx' },
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic',
    plugins: [{ name: 'calendar-context', setup(builder) {
      builder.onLoad({ filter: /[\\/]auth[\\/]Auth.jsx$/ }, () => ({ contents: 'export const useAuth=()=>({user:{id:"account-a",email:"a@example.com"}});', loader: 'js' }));
      builder.onLoad({ filter: /useJournalEntries.js$/ }, () => ({ contents: 'export const useJournalEntries=()=>globalThis.__calendarEntries;', loader: 'js' }));
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

test('calendar links only single-entry days, distinguishes today/selection, and exposes accessible counts', async () => {
  const { Calendar } = await components;
  const byDay = groupEntriesByDay([entry('single', 2026, 10, 1), entry('a', 2026, 10, 2), entry('b', 2026, 10, 2)]).byDay;
  const props = { month: new Date(2026, 9, 1), todayKey: '2026-10-03', selectedKey: '2026-10-02', mode: 'mood', byDay, status: 'ready' };
  const html = render(Calendar, props);
  assert.match(html, /href="\/journal\/single"/);
  assert.doesNotMatch(html, /href="\/journal\/(?:a|b)"/);
  assert.match(html, /2 journals, mood unavailable/);
  assert.match(html, /aria-current="date"/);
  assert.match(html, /aria-selected="true"/);
  assert.match(html, /Mood information is not available/);
  assert.equal((html.match(/calendar-entry-dot/g) || []).length, 2);
  const loading = render(Calendar, { ...props, status: 'loading' });
  assert.doesNotMatch(loading, /href="\/journal\//);
  assert.doesNotMatch(loading, /calendar-entry-dot/);
  assert.match(loading, /journal activity unavailable/);
});

test('mode rendering preserves dates, has real heat levels and supports future mood fixtures', async () => {
  const { Calendar } = await components;
  const byDay = groupEntriesByDay(Array.from({ length: 5 }, (_, i) => entry(`id${i}`, 2026, 10, 1))).byDay;
  const props = { month: new Date(2026, 9, 1), todayKey: '2026-10-03', selectedKey: '2026-10-01', byDay, status: 'ready' };
  const heatmap = render(Calendar, { ...props, mode: 'heatmap' });
  assert.match(heatmap, /--calendar-day-color:#eaa0bd/);
  assert.match(heatmap, /4\+ entries/);
  assert.match(heatmap, /5 journals/);
  assert.equal((heatmap.match(/data-date=/g) || []).length, 31);
  const mood = render(Calendar, { ...props, mode: 'mood', moodsByDay: new Map([['2026-10-01', 'happy']]) });
  assert.match(mood, /--calendar-day-color:#f4e4bd/);
  assert.match(mood, /5 journals, Happy/);
  assert.equal((mood.match(/data-date=/g) || []).length, 31);
});

test('selected day shows exact entry links, empty feedback and bounded initial cards', async () => {
  const { SelectedDayEntries } = await components;
  const rows = Array.from({ length: 25 }, (_, i) => entry(`day-${i}`, 2026, 10, 2));
  const html = render(SelectedDayEntries, { dateKey: '2026-10-02', entries: rows });
  assert.equal((html.match(/class="journal-card /g) || []).length, 20);
  assert.match(html, /href="\/journal\/day-0"/);
  assert.match(html, /href="\/journal\/day-19"/);
  assert.match(html, /25 journals/);
  assert.match(html, /Show more journals/);
  assert.match(render(SelectedDayEntries, { dateKey: '2026-10-02', entries: [] }), /No journals on this date/);
});

test('Dashboard preserves loading/error/empty distinctions and excludes unrelated widgets', async () => {
  const { default: DashboardPage } = await components;
  globalThis.__calendarEntries = { entries: [], status: 'loading', reload() {} };
  const loading = render(DashboardPage);
  assert.match(loading, /Loading your journal activity/);
  assert.doesNotMatch(loading, /No journals yet|No current streak/);
  globalThis.__calendarEntries = { entries: [], status: 'error', error: 'Connection failed', reload() {} };
  const failed = render(DashboardPage);
  assert.match(failed, /Connection failed/);
  assert.match(failed, /Try again/);
  assert.doesNotMatch(failed, /No journals yet/);
  globalThis.__calendarEntries = { entries: [], status: 'ready', reload() {} };
  const empty = render(DashboardPage);
  assert.match(empty, /No journals yet/);
  assert.match(empty, /No current streak/);
  assert.doesNotMatch(empty, /Moments saved|MOST MENTIONED|Watch recap|music-player|record-trigger/);
});

test('Dashboard reads month, mode and selected day from URL and rejects invalid dates', async () => {
  const { default: DashboardPage } = await components;
  globalThis.__calendarEntries = { entries: [entry('one', 2026, 10, 2), entry('two', 2026, 10, 2)], status: 'ready', reload() {} };
  const html = render(DashboardPage, {}, '/dashboard?month=2026-10&date=2026-10-02&mode=heatmap');
  assert.match(html, /October 2026/);
  assert.match(html, /href="\/journal\/one"/);
  assert.match(html, /href="\/journal\/two"/);
  assert.match(html, /Entries per day/);
  const invalid = render(DashboardPage, {}, '/dashboard?month=2026-10&date=2026-10-99&mode=invalid');
  assert.doesNotMatch(invalid, /dashboard-day-entries/);
  assert.match(invalid, /Mood color legend/);
});
