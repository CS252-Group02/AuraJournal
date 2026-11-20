import { useTheme } from './ThemeProvider.jsx';
import { THEMES } from './theme.js';

export default function AppearanceToggle({ className = '' }) {
  const { theme, setTheme } = useTheme();
  return <div className={`appearance-toggle ${className}`} role="group" aria-label="Appearance">
    {THEMES.map(value => <button key={value} type="button" aria-pressed={theme === value}
      onClick={() => setTheme(value)}>{value === 'light' ? 'Light' : 'Dark'}</button>)}
  </div>;
}
