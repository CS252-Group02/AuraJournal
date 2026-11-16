import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar.jsx';
import FloatingRecordButton from './FloatingRecordButton.jsx';
import NavigationIcon from './NavigationIcon.jsx';
import { navigationMode, shouldGuardLink } from './navigation.js';

export default function AppShell() {
  const location = useLocation(), mode = navigationMode(location.pathname);
  const [mobile, setMobile] = useState(() => Boolean(globalThis.matchMedia?.('(max-width: 767px)').matches));
  const [open, setOpen] = useState(false);
  const dialog = useRef(null), opener = useRef(null), guard = useRef(null), restoreFocus = useRef(true);
  const drawerMode = mode.record || mobile;
  const registerNavigationGuard = useCallback(callback => {
    guard.current = callback;
    return () => { if (guard.current === callback) guard.current = null; };
  }, []);
  const openSidebar = useCallback(event => {
    opener.current = event?.currentTarget || document.activeElement; restoreFocus.current = true; setOpen(true);
  }, []);
  const closeSidebar = useCallback((restore = true) => { restoreFocus.current = restore; setOpen(false); }, []);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px)');
    const resize = () => { setMobile(query.matches); closeSidebar(); };
    query.addEventListener('change', resize);
    return () => query.removeEventListener('change', resize);
  }, [closeSidebar]);
  useEffect(() => { closeSidebar(false); }, [location.key, closeSidebar]);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && drawerMode) {
      if (!element.open) element.showModal();
      const overflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        if (element.open) element.close();
        document.body.style.overflow = overflow;
        if (restoreFocus.current && opener.current?.isConnected) opener.current.focus({ preventScroll: true });
      };
    }
  }, [open, drawerMode]);
  function protectNavigation(event) {
    const link = event.target.closest?.('a[href]');
    if (shouldGuardLink(event, link, window.location) && guard.current && !guard.current()) event.preventDefault();
  }
  return <div className={`app-shell${mode.record ? ' app-shell-record' : ''}${mode.floatingRecord ? ' has-floating-record' : ''}`}
    onClickCapture={protectNavigation}>
    <a className="shell-skip" href="#app-content">Skip to content</a>
    {!drawerMode && <Sidebar />}
    {mobile && !mode.record && <button className="shell-mobile-toggle" type="button" onClick={openSidebar}
      aria-label="Open navigation" aria-expanded={open} aria-controls="app-navigation-drawer"><NavigationIcon name="menu" /></button>}
    {drawerMode && <dialog ref={dialog} id="app-navigation-drawer" className="shell-navigation-dialog" aria-label="Journal navigation"
      onCancel={event => { event.preventDefault(); closeSidebar(); }} onClose={() => setOpen(false)}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); closeSidebar(); return; }
        if (event.key !== 'Tab') return;
        const controls = [...event.currentTarget.querySelectorAll('a[href], button:not(:disabled)')];
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}
      onClick={event => { if (event.target === event.currentTarget) closeSidebar(); }}>
      <Sidebar drawer onClose={() => closeSidebar()} onNavigate={() => closeSidebar(false)} />
    </dialog>}
    <div className="shell-content" id="app-content" tabIndex={-1}>
      <Outlet context={{ openSidebar, sidebarOpen: open, registerNavigationGuard }} />
    </div>
    {mode.floatingRecord && <FloatingRecordButton />}
  </div>;
}
