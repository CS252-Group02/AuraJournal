import { addDays, parseDateKey, toDateKey } from '../../lib/localDate.js';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
export const MIN_MEMORY_DATE = '1000-01-07';
export const GENERATION_STATES = ['pending', 'processing', 'ready', 'failed', 'unavailable', 'uncertain', 'not_requested'];
const validTimestamp = value => typeof value === 'string' && TIMESTAMP.test(value) &&
  parseDateKey(value.slice(0, 10)) && Number.isFinite(Date.parse(value));

export function memoryDates(asOf) {
  const end = parseDateKey(asOf);
  if (!end || asOf < MIN_MEMORY_DATE) throw new Error('Choose a valid memory end date.');
  return Array.from({ length: 7 }, (_, index) => toDateKey(addDays(end, index - 6)));
}

export function validMemoryImage(record) {
  const image = record?.image;
  return Boolean(typeof record?.entry_id === 'string' && UUID.test(record.entry_id) &&
    typeof image?.id === 'string' && UUID.test(image.id) &&
    image.file_format === 'png' && image.width === 128 && image.height === 128 &&
    validTimestamp(image.created_at) && image.content_url === `/api/entries/${record.entry_id}/pixel-art/content`);
}

export function validateMemoryFeed(feed, asOf) {
  memoryDates(asOf);
  const invalid = () => { throw new Error('Invalid pixel memory metadata.'); };
  if (feed?.as_of !== asOf || !Array.isArray(feed.days) || feed.days.length > 7) invalid();
  const dates = new Set(), entries = new Set(), images = new Set();
  return { as_of: asOf, days: feed.days.map(day => {
    if (!parseDateKey(day?.journal_date) || day.journal_date > asOf || dates.has(day.journal_date) ||
        !Array.isArray(day.entries) || !day.entries.length) invalid();
    dates.add(day.journal_date);
    return { journal_date: day.journal_date, entries: day.entries.map(record => {
      const generation = record?.generation;
      if (typeof record?.entry_id !== 'string' || !UUID.test(record.entry_id) || entries.has(record.entry_id) || !generation ||
          !GENERATION_STATES.includes(generation.status) ||
          !(generation.error_code === null || typeof generation.error_code === 'string') ||
          !(generation.updated_at === null || validTimestamp(generation.updated_at)) ||
          !(record.image === null || validMemoryImage(record)) ||
          (generation.status === 'ready' && !record.image)) invalid();
      entries.add(record.entry_id);
      if (record.image && images.has(record.image.id)) invalid();
      if (record.image) images.add(record.image.id);
      return { entry_id: record.entry_id, image: record.image && {
        id: record.image.id, file_format: 'png', width: 128, height: 128,
        created_at: record.image.created_at, content_url: record.image.content_url,
      }, generation: { status: generation.status, error_code: generation.error_code, updated_at: generation.updated_at } };
    }) };
  }) };
}

export function validateMemoryJournals(entries) {
  const seen = new Set();
  if (!Array.isArray(entries)) throw new Error('Invalid journal metadata.');
  return entries.map(entry => {
    if (typeof entry?.id !== 'string' || !UUID.test(entry.id) || seen.has(entry.id) || !parseDateKey(entry.journal_date) || typeof entry.content !== 'string') {
      throw new Error('Invalid journal metadata.');
    }
    seen.add(entry.id);
    return { id: entry.id, content: entry.content, journal_date: entry.journal_date };
  });
}

// Occupied backend dates never determine calendar positions. Only a ready,
// validated image bound to the current journal/date can enter a carousel.
export function mapPixelMemories(entries, feed, asOf) {
  const days = memoryDates(asOf).map(key => ({ key, entries: [], images: [], invalid: false }));
  const byDate = new Map(days.map(day => [day.key, day]));
  const byEntry = new Map(entries.map(entry => [entry.id, entry]));
  let invalidCount = 0;
  for (const group of feed?.days || []) {
    const day = byDate.get(group.journal_date);
    if (!day) continue;
    for (const record of group.entries) {
      const entry = byEntry.get(record.entry_id);
      if (!entry || entry.journal_date !== day.key) {
        day.invalid = true; invalidCount++; continue;
      }
      const memory = { ...record, entry, identity: `${record.entry_id}:${record.image?.id || ''}` };
      day.entries.push(memory);
      if (record.generation.status === 'ready' && validMemoryImage(record)) day.images.push(memory);
    }
    day.images.sort((a, b) => Date.parse(a.image.created_at) - Date.parse(b.image.created_at) ||
      a.entry_id.localeCompare(b.entry_id));
  }
  return { days, invalidCount };
}

export function hasPendingMemories(feed, asOf) {
  const dates = new Set(memoryDates(asOf));
  return Boolean(feed?.days.some(day => dates.has(day.journal_date) &&
    day.entries.some(entry => ['pending', 'processing'].includes(entry.generation.status))));
}

export function selectedMemory(images, identity) {
  return images.find(image => image.identity === identity) || images[0];
}

export function generationLabel(generation) {
  if (generation.status === 'failed' && ['image_missing', 'invalid_reference', 'storage_unavailable'].includes(generation.error_code)) return 'Image unavailable';
  return {
    pending: 'Waiting for artwork', processing: 'Preparing artwork…', ready: 'Artwork ready',
    failed: 'Artwork could not be prepared', unavailable: 'Artwork service unavailable',
    uncertain: 'Artwork completion unconfirmed', not_requested: 'No artwork scheduled',
  }[generation.status];
}
