import { useLayoutEffect } from 'react';
import { matchPath, useOutletContext } from 'react-router-dom';

export function navigationMode(pathname) {
  const path = pathname.replace(/\/+$/, '') || '/';
  return {
    record: path === '/record',
    floatingRecord: ['/dashboard', '/history', '/reflection'].includes(path) || Boolean(matchPath('/journal/:id', path)),
  };
}

// BrowserRouter remains the router. Guard only same-tab departures through links;
// native reload/close protection stays with the page's existing beforeunload hook.
export function shouldGuardLink(event, link, location) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey ||
      !link || link.hasAttribute('download') || (link.target && link.target !== '_self')) return false;
  const destination = new URL(link.href, location.href);
  return destination.origin === location.origin &&
    (destination.pathname !== location.pathname || destination.search !== location.search);
}

export function useNavigationGuard(guard) {
  const shell = useOutletContext();
  const register = shell?.registerNavigationGuard;
  useLayoutEffect(() => register?.(guard), [register, guard]);
  return Boolean(register);
}
