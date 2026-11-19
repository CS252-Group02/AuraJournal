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
import { parseDateKey, toDateKey } from '../src/frontend/src/lib/localDate.js';
import { calendarKeyboardDate, currentStreak, dateInMonth, groupEntriesByDay, HEATMAP, heatLevel, moodPresentation,
  monthCells, monthKey, parseMonthKey, shiftMonth } from '../src/frontend/src/features/calendar/calendarModel.js';
import { calendarViewParams, calendarViewState } from '../src/frontend/src/features/calendar/useCalendarView.js';

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

test('Calendar uses saved journal dates for backdated entries and rejects malformed dates instead of normalizing them', () => {
  const rows = [entry('backdated', 2026, 11, 12, { journal_date: '2024-02-29' }),
    entry('same-day', 2026, 10, 1, { journal_date: '2024-02-29' }), entry('legacy', 2026, 11, 12, { journal_date: null }),
    ...['2026-02-29', '2026-11-31', '2026-11-12T12:00:00Z', '', 20261112].map(journal_date => ({ journal_date, created_at: '2026-11-12T12:00:00Z' })),
    ...['2026-02-30T12:00:00Z', '2026-11-12T24:00:00Z', '2026-11-12', '2026-11-12T12:00:00'].map(created_at => ({ created_at }))];
  const { byDay, invalidCount } = groupEntriesByDay(rows);
  assert.deepEqual(byDay.get('2024-02-29'), rows.slice(0, 2));
  assert.deepEqual(byDay.get('2026-11-12'), [rows[2]]);
  assert.equal(invalidCount, 9);
  assert.equal(byDay.size, 2);
});

test('date-only URLs open their month, explicit months win conflicts, and Heatmap is the reliable default', () => {
  const state = query => calendarViewState(new URLSearchParams(query), '2026-11-19');
  assert.equal(monthKey(state('date=2024-02-29').month), '2024-02');
  assert.equal(state('date=2024-02-29').selectedKey, '2024-02-29');
  assert.equal(state('month=2026-10&date=2024-02-29').selectedKey, null);
  assert.equal(monthKey(state('month=invalid&date=2024-02-29').month), '2024-02');
  assert.equal(monthKey(state('date=2026-02-29').month), '2026-11');
  assert.equal(state('').mode, 'heatmap');
  assert.equal(state('mode=unknown').mode, 'heatmap');
  assert.equal(state('mode=mood').mode, 'mood');
});

test('URL transitions retain and clamp selection, preserve unrelated params and stay stable through repeated actions', () => {
  const today = '2026-11-19';
  let params = new URLSearchParams('month=2026-01&date=2026-01-31&mode=heatmap&keep=private');
  const update = action => { params = calendarViewParams(params, action, today); return calendarViewState(params, today); };
  assert.equal(update({ type: 'month', month: '2026-02' }).selectedKey, '2026-02-28');
  assert.equal(update({ type: 'month', month: '2026-03' }).selectedKey, '2026-03-28');
  assert.equal(update({ type: 'date', key: '2024-02-29' }).selectedKey, '2024-02-29');
  assert.equal(update({ type: 'month', month: '2025-02' }).selectedKey, '2025-02-28');
  update({ type: 'mode', mode: 'mood' });
  assert.equal(params.get('date'), '2025-02-28');
  assert.equal(params.get('keep'), 'private');
  const before = params.toString();
  for (const action of [{ type: 'month', month: 'bad' }, { type: 'date', key: '2026-02-29' }, { type: 'mode', mode: 'bad' }]) {
    update(action); assert.equal(params.toString(), before);
  }
  update({ type: 'date', key: '2025-02-28' });
  assert.equal(params.toString(), before);
  assert.equal(update({ type: 'today' }).selectedKey, today);
  assert.equal(params.get('month'), '2026-11');
  assert.equal(params.get('mode'), 'mood');
  params = new URLSearchParams('month=2026-01&date=2026-01-01');
  for (let i = 1; i <= 120; i++) update({ type: 'month', month: monthKey(shiftMonth(parseMonthKey('2026-01'), i)) });
  assert.equal(params.get('date'), '2036-01-01');
});

test('calendar keyboard movements respect week, month, leap day, year and supported-year boundaries', () => {
  const move = (key, day) => calendarKeyboardDate(parseDateKey(day), key);
  for (const [key, day, expected] of [
    ['ArrowLeft', '2026-01-01', '2025-12-31'], ['ArrowRight', '2026-12-31', '2027-01-01'],
    ['ArrowUp', '2024-03-01', '2024-02-23'], ['ArrowDown', '2024-02-23', '2024-03-01'],
    ['Home', '2026-11-01', '2026-11-01'], ['End', '2026-11-30', '2026-11-30'],
    ['Home', '2026-11-19', '2026-11-16'], ['End', '2026-11-19', '2026-11-22'],
    ['PageDown', '2024-01-31', '2024-02-29'], ['PageUp', '2026-03-31', '2026-02-28'],
  ]) assert.equal(toDateKey(move(key, day)), expected);
  assert.equal(move('ArrowLeft', '1000-01-01'), null);
  assert.equal(move('ArrowRight', '9999-12-31'), null);
  assert.equal(move('Enter', '2026-11-19'), null);
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
      builder.onLoad({ filter: /[\\/]lib[\\/]api.js$/ }, () => ({ contents: 'export const api=()=>{throw new Error("Unexpected API request")};', loader: 'js' }));
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
  assert.match(invalid, /Entries per day/);
});

// Exercise real component event handlers and effects without a browser or an
// extra DOM dependency. Refs expose only the focus operation Calendar uses.
async function calendarInteraction(query, entries = []) {
  const slots = [], focusCalls = [];
  let cursor = 0, effects = [], dirty = false, tree, mounted = [];
  let params = new URLSearchParams(query);
  const hooks = { ...React,
    useMemo: compute => compute(),
    useState(initial) {
      const index = cursor++;
      slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, value => {
        const next = typeof value === 'function' ? value(slots[index].value) : value;
        if (!Object.is(next, slots[index].value)) { slots[index].value = next; dirty = true; }
      }];
    },
    useRef(value) { const index = cursor++; return slots[index] ??= { current: value }; },
    useEffect(effect, deps) {
      const index = cursor++, previous = slots[index];
      if (!previous || deps.some((value, i) => !Object.is(previous[i], value))) {
        effects.push(effect); slots[index] = deps;
      }
    },
  };
  const result = await build({ entryPoints: [fileURLToPath(new URL('../src/frontend/src/features/calendar/Calendar.jsx', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic' });
  const module = { exports: {} }, require = createRequire(import.meta.url);
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(name => name === 'react' ? hooks : require(name), module, module.exports);
  const Component = module.exports.default;
  function nodes(value) {
    if (Array.isArray(value)) return value.flatMap(child => nodes(child));
    return React.isValidElement(value) ? [value, ...nodes(value.props.children)] : [];
  }
  function update(action) { params = calendarViewParams(params, action, '2024-03-19'); dirty = true; }
  function render() {
    for (let count = 0; count < 10; count++) {
      dirty = false; cursor = 0; effects = [];
      mounted.forEach(node => node.props.ref(null));
      tree = Component({ ...calendarViewState(params, '2024-03-19'), todayKey: '2024-03-19',
        byDay: groupEntriesByDay(entries).byDay, status: 'ready',
        onMonthChange: (date, offset) => update({ type: 'month', month: monthKey(date), offset }),
        onSelectDate: key => update({ type: 'date', key }), onToday: () => update({ type: 'today' }),
        onModeChange: mode => update({ type: 'mode', mode }),
      });
      mounted = nodes(tree).filter(node => typeof node.props.ref === 'function');
      mounted.forEach(node => node.props.ref({ focus: () => focusCalls.push(node.props['data-date']) }));
      effects.forEach(effect => effect());
      if (!dirty) return;
    }
    assert.fail('Calendar effects failed to settle');
  }
  render();
  return { nodes: () => nodes(tree), render, focusCalls, get params() { return params; },
    day(key) { return nodes(tree).find(node => node.props['data-date'] === key); },
    select(key) { update({ type: 'date', key }); render(); },
  };
}

test('calendar keyboard handlers move the actual tab stop and focus across leap day and month changes', async () => {
  const f = await calendarInteraction('month=2024-02&date=2024-02-28');
  let prevented = 0;
  f.day('2024-02-28').props.onKeyDown({ key: 'ArrowRight', preventDefault() { prevented++; } }); f.render();
  assert.equal(f.day('2024-02-29').props.tabIndex, 0);
  assert.equal(f.focusCalls.at(-1), '2024-02-29');
  f.day('2024-02-29').props.onKeyDown({ key: 'ArrowRight', preventDefault() { prevented++; } }); f.render();
  assert.equal(f.params.get('month'), '2024-03');
  assert.equal(f.day('2024-03-01').props.tabIndex, 0);
  assert.equal(f.focusCalls.at(-1), '2024-03-01');
  assert.equal(prevented, 2);
  assert.equal(f.nodes().filter(node => node.props['data-date'] && node.props.tabIndex === 0).length, 1);
  const before = f.focusCalls.length;
  f.select('2024-03-19');
  assert.equal(f.day('2024-03-19').props.tabIndex, 0);
  assert.equal(f.focusCalls.length, before); // Selection does not steal focus from the picker.
});

test('single-entry activation retains selection and modified clicks leave the current URL alone', async () => {
  const f = await calendarInteraction('month=2024-03&mode=heatmap', [entry('one', 2024, 3, 1)]);
  const day = f.day('2024-03-01');
  assert.equal(day.props.to, '/journal/one');
  for (const event of [{ button: 1 }, { button: 0, ctrlKey: true }, { button: 0, metaKey: true },
    { button: 0, shiftKey: true }, { button: 0, altKey: true }, { button: 0, defaultPrevented: true }]) {
    day.props.onClick(event); assert.equal(f.params.get('date'), null);
  }
  day.props.onClick({ button: 0 }); f.render();
  assert.equal(f.params.get('date'), '2024-03-01');
  assert.match(f.day('2024-03-01').props.className, /is-selected/);
  f.nodes().find(node => node.type === 'input' && node.props.type === 'date').props.onChange({ target: { value: '2024-03-01' } }); f.render();
  assert.equal(f.params.get('date'), '2024-03-01');
});

test('month picker, display toggle and Today share URL selection state', async () => {
  const f = await calendarInteraction('month=2024-01&date=2024-01-31');
  f.nodes().find(node => node.type === 'input' && node.props.type === 'month').props.onChange({ target: { value: '2024-02' } }); f.render();
  assert.equal(f.params.get('date'), '2024-02-29');
  f.nodes().find(node => node.type === 'button' && node.props.children === 'Mood').props.onClick(); f.render();
  assert.equal(f.params.get('mode'), 'mood');
  assert.equal(f.params.get('date'), '2024-02-29');
  f.nodes().find(node => node.type === 'button' && node.props.children === 'Today').props.onClick(); f.render();
  assert.equal(f.params.get('month'), '2024-03');
  assert.equal(f.params.get('date'), '2024-03-19');
  assert.equal(f.day('2024-03-19').props['aria-current'], 'date');
});

test('the view hook composes rapid month/mode actions before render and accepts external URL changes', async () => {
  let params = new URLSearchParams('month=2024-01&date=2024-01-31'), ref;
  const navigations = [];
  const result = await build({ entryPoints: [fileURLToPath(new URL('../src/frontend/src/features/calendar/useCalendarView.js', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
    plugins: [{ name: 'fixed-calendar-clock', setup(builder) {
      builder.onLoad({ filter: /useLocalDay.js$/ }, () => ({ contents: 'export const useLocalDay=()=>({todayKey:"2024-03-19",timezone:"UTC",refresh:()=>({todayKey:"2024-03-20"})});', loader: 'js' }));
    } }],
  });
  const module = { exports: {} }, require = createRequire(import.meta.url);
  const mockedRequire = name => name === 'react' ? { useRef: initial => ref ??= { current: initial } }
    : name === 'react-router-dom' ? { useSearchParams: () => {
      const rendered = params;
      return [rendered, (value, options) => {
        params = typeof value === 'function' ? value(rendered) : value;
        navigations.push({ params, options });
      }];
    } } : require(name);
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(mockedRequire, module, module.exports);
  const view = module.exports.useCalendarView();
  view.changeMonth(new Date(2024, 1, 1), 1);
  view.changeMonth(new Date(2024, 1, 1), 1); // Same rendered button, before router rerenders.
  view.changeMode('mood');
  assert.equal(params.get('month'), '2024-03');
  assert.equal(params.get('date'), '2024-03-29');
  assert.equal(params.get('mode'), 'mood');
  assert.ok(navigations.every(call => call.options.replace));
  params = new URLSearchParams('month=2023-12&date=2023-12-31&mode=heatmap');
  const back = module.exports.useCalendarView();
  assert.equal(back.selectedKey, '2023-12-31');
  back.changeMonth(new Date(2024, 0, 1), 1);
  assert.equal(params.get('date'), '2024-01-31');
  back.goToday();
  assert.equal(params.get('date'), '2024-03-20');
  assert.equal(params.get('month'), '2024-03');
});
