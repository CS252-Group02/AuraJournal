export const THEME_KEY = 'aurajournal-theme';
export const DEFAULT_THEME = 'light';
export const THEMES = ['light', 'dark'];

export function normalizeTheme(value) {
  return THEMES.includes(value) ? value : DEFAULT_THEME;
}

export function readTheme() {
  try { return normalizeTheme(window.localStorage.getItem(THEME_KEY)); }
  catch { return DEFAULT_THEME; }
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = normalizeTheme(theme);
}

export function persistTheme(theme) {
  try { window.localStorage.setItem(THEME_KEY, normalizeTheme(theme)); }
  catch { /* The current session can still change appearance without storage. */ }
}
