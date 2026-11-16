import assert from 'node:assert/strict';
import test from 'node:test';

import { entryPreview, entryTitle, entryTone, matchesSearch, readMinutes, TONES, wordCount } from '../src/frontend/src/features/journal/entryText.js';
import { formatEntryDate } from '../src/frontend/src/features/journal/formatEntryDate.js';
import { addDays, entriesByDay, parseDateKey, startOfWeek, toDateKey, weekDays } from '../src/frontend/src/features/reflection/week.js';

test('titles use the first sentence and stay short', () => {
  assert.equal(entryTitle('Rainy morning. Coffee and a walk.'), 'Rainy morning');
  assert.equal(entryTitle('Called mom!\nShe asked about exams.'), 'Called mom!');
  assert.equal(entryTitle('  '), 'Untitled entry');
  const long = entryTitle('Group meeting ran long, but we split the UI work into four groups and I took journal management.');
  assert.ok(long.length <= 61 && long.endsWith('…'), long);
});

test('previews skip the title sentence and are empty for one-sentence entries', () => {
  assert.equal(entryPreview('Rainy morning. Coffee and a walk.'), 'Coffee and a walk.');
  assert.equal(entryPreview('Called mom.\n\nI should call more often.'), 'I should call more often.');
  assert.equal(entryPreview('Just one line.'), '');
  const sentence = 'Group meeting ran long, but we split the UI work into four groups and I took journal management.';
  assert.equal(entryPreview(sentence), sentence, 'a clipped single sentence is shown in full');
});

test('word count and reading time', () => {
  assert.equal(wordCount(' one  two\nthree '), 3);
  assert.equal(readMinutes('short'), 1);
  assert.equal(readMinutes('word '.repeat(600)), 3);
});

test('tones are stable per entry id', () => {
  assert.equal(entryTone('abc'), entryTone('abc'));
  assert.ok(TONES.includes(entryTone('3f2a-…')));
});

test('search matches entry text and AI notes, case-insensitively', () => {
  const entry = { content: 'A slow Walk to class', ai_summary: 'Quiet start', ai_reflection_question: null };
  assert.ok(matchesSearch(entry, 'walk'));
  assert.ok(matchesSearch(entry, 'QUIET'));
  assert.ok(matchesSearch(entry, '  '));
  assert.ok(!matchesSearch(entry, 'exam'));
});

test('entry dates read as Today / Yesterday / weekday', () => {
  const now = new Date(2026, 10, 11, 22, 0);
  assert.match(formatEntryDate(new Date(2026, 10, 11, 21, 12), now), /^Today · /);
  assert.match(formatEntryDate(new Date(2026, 10, 10, 0, 5), now), /^Yesterday · /);
  assert.match(formatEntryDate(new Date(2025, 11, 31, 23, 0), now), /2025/);
  assert.equal(formatEntryDate('not a date', now), '');
});

test('weeks start on Monday and group entries by local day', () => {
  const wednesday = new Date(2026, 10, 11, 15);
  const start = startOfWeek(wednesday);
  assert.equal(toDateKey(start), '2026-11-09');
  assert.equal(toDateKey(startOfWeek(new Date(2026, 10, 15, 23))), '2026-11-09', 'Sunday belongs to the week before');
  assert.deepEqual(weekDays(start).map((day) => day.getDate()), [9, 10, 11, 12, 13, 14, 15]);
  assert.equal(toDateKey(addDays(start, -7)), '2026-11-02');

  const byDay = entriesByDay([
    { id: 'a', created_at: new Date(2026, 10, 9, 8).toISOString() },
    { id: 'b', created_at: new Date(2026, 10, 9, 20).toISOString() },
    { id: 'c', created_at: new Date(2026, 10, 16, 1).toISOString() },
  ], start);
  assert.equal(byDay.get('2026-11-09').length, 2);
  assert.equal([...byDay.values()].flat().length, 2, 'entries outside the week are ignored');
});

test('date keys reject invalid input', () => {
  assert.equal(toDateKey(parseDateKey('2026-02-28')), '2026-02-28');
  assert.equal(parseDateKey('2026-02-30'), null);
  assert.equal(parseDateKey('next week'), null);
  assert.equal(parseDateKey(null), null);
});
