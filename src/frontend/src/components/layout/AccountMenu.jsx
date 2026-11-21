import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePresence } from '../../lib/motion.js';
import { Link, useLocation, useOutletContext } from 'react-router-dom';
import { useAuth } from '../../auth/Auth.jsx';
import AppearanceToggle from '../../theme/AppearanceToggle.jsx';
import { ACCOUNT_NAVIGATION } from './accountNavigation.js';

export default function AccountMenu({ className = '', beforeLeave }) {
  const { user, logout } = useAuth();
  const shell = useOutletContext();
  const location = useLocation();
  const [open, setOpen] = useState(false), [pending, setPending] = useState(false);
  const presence = usePresence(open, 110);
  const [notice, setNotice] = useState('');
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const trigger = useRef(null), panel = useRef(null), submitting = useRef(false);
  const id = useId();
  const confirmLeave = shell?.confirmNavigation || beforeLeave || (() => true);

  function close(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }

  useEffect(() => { setOpen(false); }, [location.key]);
  useLayoutEffect(() => {
    if (!open) return;
    function reposition() {
      const anchor = trigger.current.getBoundingClientRect();
      const rect = panel.current.getBoundingClientRect();
      setPosition({
        left: Math.max(12, Math.min(anchor.right - rect.width, window.innerWidth - rect.width - 12)),
        top: Math.max(12, Math.min(anchor.bottom + 10, window.innerHeight - rect.height - 12)),
      });
    }
    reposition();
    panel.current.querySelector('a[href], button:not(:disabled)')?.focus({ preventScroll: true });
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function outside(event) {
      if (!panel.current?.contains(event.target) && !trigger.current?.contains(event.target)) close();
    }
    function escape(event) {
      if (event.key === 'Escape') { event.preventDefault(); close(true); }
    }
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  async function signOut() {
    if (submitting.current) return;
    if (!confirmLeave()) {
      setNotice('Stay here to keep your work. Finish any active save before logging out.');
      return;
    }
    submitting.current = true;
    setPending(true);
    setNotice('');
    try { await logout(); }
    finally { submitting.current = false; setPending(false); }
    // AuthProvider owns session failures and protected-route navigation.
  }

  return <div className={`account-menu ${className}`}>
    <button ref={trigger} type="button" className="account-trigger" aria-label="Your account" title={user?.email}
      aria-expanded={open} aria-controls={id} onClick={() => { setNotice(''); setOpen(value => !value); }}>
      <span aria-hidden="true">{user?.email?.[0]?.toUpperCase() || '?'}</span>
    </button>
    {presence.mounted && createPortal(<div ref={panel} id={id} className={`account-panel${presence.leaving ? ' is-leaving' : ''}`}
      role="region" aria-label="Your account" inert={presence.leaving} style={position} onKeyDown={event => {
        if (event.key !== 'Tab') return;
        const controls = [...panel.current.querySelectorAll('a[href], button:not(:disabled)')];
        if ((event.shiftKey && event.target === controls[0]) || (!event.shiftKey && event.target === controls.at(-1))) {
          event.preventDefault(); close(true);
        }
      }}>
      <div className="account-info"><span>Signed in as</span><p>{user?.email}</p></div>
      <nav className="account-navigation" aria-label="Account navigation">
        {ACCOUNT_NAVIGATION.map(item => item.available
          ? <Link key={item.id} to={item.to} className="account-action" onClick={event => {
            // AppShell captures link clicks, including React portal events.
            if (event.defaultPrevented) return;
            if (shell?.confirmNavigation || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
            if (!confirmLeave()) event.preventDefault();
          }}>{item.label}</Link>
          : <button key={item.id} type="button" className="account-action" disabled>{item.label} <span>— Coming soon</span></button>)}
      </nav>
      <div className="account-appearance"><span>Appearance</span><AppearanceToggle /></div>
      <div className="account-session"><button type="button" className="account-action" onClick={signOut}
        disabled={pending} aria-busy={pending}>{pending ? 'Logging out…' : 'Log out'}</button></div>
      <p className="account-status" role="status">{notice}</p>
    </div>, document.body)}
  </div>;
}
