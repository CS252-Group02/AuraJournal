const PREFIX = 'aurajournal:last-opened:';

export function getLastOpened(userId) {
  try {
    const value = JSON.parse(localStorage.getItem(PREFIX + userId) || 'null');
    return value && typeof value.id === 'string' ? value : null;
  } catch {
    return null;
  }
}

export function setLastOpened(userId, entryId, openedAt = new Date().toISOString()) {
  try {
    localStorage.setItem(PREFIX + userId, JSON.stringify({ id: entryId, openedAt }));
  } catch {}
}

export function forgetLastOpened(userId, entryId) {
  try {
    if (getLastOpened(userId)?.id === entryId) localStorage.removeItem(PREFIX + userId);
  } catch {}
}
