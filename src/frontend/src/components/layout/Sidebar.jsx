import { useState } from 'react';
import { Link, matchPath, useLocation } from 'react-router-dom';
import NavigationIcon from './NavigationIcon.jsx';

const ITEMS = [
  { to: '/', label: 'Main', icon: 'main' },
  { to: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
  { to: '/history', label: 'History', icon: 'history' },
  { to: '/reflection', label: 'Weekly recap', icon: 'reflection', secondary: true },
];

export default function Sidebar({ drawer = false, onClose, onNavigate }) {
  const [pinned, setPinned] = useState(false), [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false);
  const { pathname } = useLocation();
  const expanded = drawer || pinned || hovered || focused;
  return <aside className={`app-sidebar${drawer ? ' is-drawer' : ''}`} data-expanded={expanded}
    onPointerEnter={event => { if (event.pointerType === 'mouse') setHovered(true); }} onPointerLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    <div className="sidebar-brand"><span aria-hidden="true">✦</span><span className="sidebar-label">AuraJournal</span></div>
    {drawer && <button type="button" className="sidebar-close" onClick={onClose} aria-label="Close navigation"><NavigationIcon name="close" /></button>}
    <nav aria-label="Main navigation"><ul>{ITEMS.map(item => {
      const detail = item.to === '/history' && pathname.startsWith('/journal/');
      const active = Boolean(matchPath(item.to, pathname)) || detail;
      return <li key={item.to} className={item.secondary ? 'sidebar-secondary' : undefined}>
        <Link to={item.to} aria-label={item.label} aria-current={active ? 'page' : undefined}
          className={`sidebar-link${active ? ' is-active' : ''}`}
          onClick={event => {
            if (!event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) onNavigate?.();
          }}><NavigationIcon name={item.icon} /><span className="sidebar-label">{item.label}</span></Link>
      </li>;
    })}</ul></nav>
    {!drawer && <button type="button" className="sidebar-pin" aria-label={pinned ? 'Unpin navigation' : 'Keep navigation expanded'}
      aria-pressed={pinned} aria-expanded={expanded} onClick={() => setPinned(value => !value)}><NavigationIcon name="expand" />
      <span className="sidebar-label">{pinned ? 'Unpin navigation' : 'Keep open'}</span></button>}
  </aside>;
}
