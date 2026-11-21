const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

export function readSearchParams(params) {
  const start = params.get('start') || '';
  const end = params.get('end') || '';
  return {
    q: (params.get('q') || '').trim(),
    start: DATE_KEY.test(start) ? start : '',
    end: DATE_KEY.test(end) ? end : '',
    sort: params.get('sort') === 'oldest' ? 'oldest' : 'newest',
  };
}

export function hasServerFilters({ q, start, end, sort }) {
  return Boolean(q || start || end || sort === 'oldest');
}

export function invalidRange({ start, end }) {
  return Boolean(start && end && start > end);
}

export function entrySearchPath(search) {
  if (!hasServerFilters(search) || invalidRange(search)) return null;
  const query = new URLSearchParams();
  if (search.q) query.set('q', search.q);
  if (search.start) query.set('start', search.start);
  if (search.end) query.set('end', search.end);
  query.set('sort', search.sort);
  return `/api/entries?${query}`;
}
