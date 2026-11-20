import { createContext, useContext, useLayoutEffect, useState } from 'react';
import { applyTheme, normalizeTheme, persistTheme, readTheme, THEME_KEY } from './theme.js';

// Standalone component previews render in Light; the application mounts one provider.
const ThemeContext = createContext({ theme: 'light', setTheme() {} });
export function useTheme() { return useContext(ThemeContext); }

export function ThemeProvider({ children }) {
  const [theme, updateTheme] = useState(() => typeof document === 'undefined' ? 'light'
    : normalizeTheme(document.documentElement.dataset.theme || readTheme()));

  useLayoutEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useLayoutEffect(() => {
    function sync(event) {
      if (event.key === THEME_KEY || event.key === null) updateTheme(readTheme());
    }
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  function setTheme(value) {
    const next = normalizeTheme(value);
    applyTheme(next);
    persistTheme(next);
    updateTheme(next);
  }

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}
