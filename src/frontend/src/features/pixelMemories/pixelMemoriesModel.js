import { addDays, parseDateKey, toDateKey } from '../../lib/localDate.js';
import { journalDayKey } from '../calendar/calendarModel.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function memoryDates(asOf) {
  const end = parseDateKey(asOf);
  if (!end) throw new Error('Choose a valid memory end date.');
  return Array.from({ length: 7 }, (_, index) => toDateKey(addDays(end, index - 6)));
}

export function validMemoryImage(record) {
  const image = record?.image;
  return UUID.test(record?.entry_id) && UUID.test(image?.id) &&
    image.file_format === 'png' && image.width === 128 && image.height === 128 &&
    TIMESTAMP.test(image.created_at) && parseDateKey(image.created_at.slice(0, 10)) && Number.isFinite(Date.parse(image.created_at)) &&
    image.content_url === `/api/entries/${record.entry_id}/pixel-art/content`;
}

// The API's latest seven occupied dates can span months and contain many images.
// Intersect with seven calendar dates AND the current owner-scoped entries.
export function mapPixelMemories(entries, records, asOf) {
  const days = memoryDates(asOf).map(key => ({ key, entries: [], images: [], invalid: false }));
  const byDate = new Map(days.map(day => [day.key, day]));
  const byEntry = new Map();
  for (const entry of entries) {
    const day = byDate.get(journalDayKey(entry));
    if (day) { day.entries.push(entry); byEntry.set(entry.id, { day, entry }); }
  }
  let invalidCount = 0;
  const seen = new Set();
  for (const record of records) {
    const match = byEntry.get(record?.entry_id);
    // Ignore valid older occupied dates; never shift them into an empty slot.
    if (!match && parseDateKey(record?.journal_date) && !byDate.has(record.journal_date)) continue;
    if (!match || match.day.key !== record.journal_date || !validMemoryImage(record)) {
      invalidCount++;
      if (match) match.day.invalid = true;
      continue;
    }
    const identity = `${record.entry_id}:${record.image.id}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    match.day.images.push({ ...record, entry: match.entry });
  }
  for (const day of days) {
    // First successfully stored image stays the daily default across reloads.
    day.images.sort((a, b) => Date.parse(a.image.created_at) - Date.parse(b.image.created_at) ||
      a.entry_id.localeCompare(b.entry_id));
    // The backend stores one current image per entry. Contradictory versions
    // cannot safely identify the bytes at its entry-based content endpoint.
    const counts = new Map();
    for (const image of day.images) counts.set(image.entry_id, (counts.get(image.entry_id) || 0) + 1);
    day.images = day.images.filter(image => {
      if (counts.get(image.entry_id) === 1) return true;
      day.invalid = true; invalidCount++;
      return false;
    });
  }
  return { days, invalidCount };
}
