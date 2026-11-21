import { useTheme } from './ThemeProvider.jsx';
import { THEMES } from './theme.js';
import SlidingPill from '../components/ui/SlidingPill.jsx';

export default function AppearanceToggle({ className = '' }) {
  const { theme, setTheme } = useTheme();
  return <div className={`appearance-toggle has-pill ${className}`} role="group" aria-label="Appearance">
    <SlidingPill active={theme} />
    {THEMES.map(value => <button key={value} type="button" aria-pressed={theme === value}
      onClick={() => setTheme(value)}>{value === 'light' ? 'Light' : 'Dark'}</button>)}
  </div>;
}
