import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export const EASE_DRAWER = 'cubic-bezier(0.32, 0.72, 0, 1)';
export const EASE_SPRING = 'cubic-bezier(0.34, 1.56, 0.64, 1)';
export const EASE_EXIT = 'cubic-bezier(0.55, 0, 1, 0.45)';

export function prefersReducedMotion() {
  if (globalThis.document?.documentElement?.dataset?.motion === 'reduced') return true;
  return Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

export function pageDepth(pathname) {
  return pathname.split('/').filter(Boolean).length;
}

export function pageDirection(from, to) {
  if (from === null || from === to) return 'none';
  const before = pageDepth(from), after = pageDepth(to);
  if (after > before) return 'forward';
  if (after < before) return 'back';
  return 'fade';
}

export function usePageDirection(pathname) {
  const [state, setState] = useState({ path: pathname, direction: 'none' });
  if (state.path !== pathname) {
    setState({ path: pathname, direction: pageDirection(state.path, pathname) });
  }
  return state.direction;
}

export function usePresence(show, exitMs) {
  const [mounted, setMounted] = useState(show);
  if (show && !mounted) setMounted(true);
  if (!show && mounted && prefersReducedMotion()) setMounted(false);
  useEffect(() => {
    if (show || !mounted) return undefined;
    const timer = setTimeout(() => setMounted(false), prefersReducedMotion() ? 0 : exitMs);
    return () => clearTimeout(timer);
  }, [show, mounted, exitMs]);
  return { mounted: show || mounted, leaving: mounted && !show };
}

function measure(box, selector, keyOf) {
  const origin = box.getBoundingClientRect();
  const items = new Map();
  for (const el of box.querySelectorAll(selector)) {
    const key = keyOf(el);
    if (!key) continue;
    const rect = el.getBoundingClientRect();
    items.set(key, { el, x: rect.left - origin.left, y: rect.top - origin.top, w: rect.width, h: rect.height });
  }
  return items;
}

export function useFlip(ref, key, { selector, keyOf, enabled = true }) {
  const last = useRef({ box: null, items: new Map() });
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box || !enabled) {
      last.current = { box: null, items: new Map() };
      return;
    }
    const fresh = last.current.box !== box;
    const animate = !fresh && !prefersReducedMotion() && typeof box.animate === 'function';
    const items = measure(box, selector, keyOf);
    if (animate) {
      for (const [id, now] of items) {
        const before = last.current.items.get(id);
        if (!before) {
          now.el.animate([{ opacity: 0, scale: 0.94, filter: 'blur(4px)' }, { opacity: 1, scale: 1, filter: 'blur(0)' }],
            { duration: 380, easing: EASE_SPRING });
        } else if (Math.abs(before.x - now.x) > 0.5 || Math.abs(before.y - now.y) > 0.5) {
          now.el.animate([{ translate: `${before.x - now.x}px ${before.y - now.y}px` }, { translate: '0 0' }],
            { duration: 380, easing: EASE_DRAWER });
        }
      }
      for (const [id, gone] of last.current.items) {
        if (items.has(id)) continue;
        const ghost = gone.el.cloneNode(true);
        ghost.setAttribute('aria-hidden', 'true');
        ghost.removeAttribute('href');
        Object.assign(ghost.style, { position: 'absolute', left: `${gone.x}px`, top: `${gone.y}px`,
          width: `${gone.w}px`, height: `${gone.h}px`, margin: '0', pointerEvents: 'none' });
        box.appendChild(ghost);
        ghost.animate([{ opacity: 1, scale: 1 }, { opacity: 0, scale: 0.9, filter: 'blur(3px)' }],
          { duration: 200, easing: EASE_EXIT, fill: 'forwards' }).finished.finally(() => ghost.remove());
      }
    }
    last.current = { box, items };
  }, [ref, key, enabled]);
}
