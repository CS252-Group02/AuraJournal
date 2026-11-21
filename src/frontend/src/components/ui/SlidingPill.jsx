import { useLayoutEffect, useRef } from 'react';

function placePill(pill, animate) {
  const on = pill.parentElement?.querySelector('[aria-pressed="true"]');
  if (!on || !on.offsetWidth) {
    pill.style.opacity = '0';
    return;
  }
  if (!animate || pill.style.opacity !== '1') pill.style.transition = 'none';
  pill.style.opacity = '1';
  pill.style.width = `${on.offsetWidth}px`;
  pill.style.height = `${on.offsetHeight}px`;
  pill.style.translate = `${on.offsetLeft}px ${on.offsetTop}px`;
  if (pill.style.transition === 'none') {
    void pill.offsetWidth;
    pill.style.transition = '';
  }
}

export default function SlidingPill({ active, tone }) {
  const pill = useRef(null);

  useLayoutEffect(() => {
    if (pill.current) placePill(pill.current, true);
  }, [active]);

  useLayoutEffect(() => {
    const element = pill.current;
    const group = element?.parentElement;
    if (!element || !group || typeof ResizeObserver === 'undefined') return undefined;
    let size = '';
    const observer = new ResizeObserver(() => {
      const next = `${group.offsetWidth}x${group.offsetHeight}`;
      if (next === size) return;
      size = next;
      placePill(element, false);
    });
    observer.observe(group);
    return () => observer.disconnect();
  }, []);

  return <span ref={pill} className="aj-pill" data-tone={tone} aria-hidden="true" />;
}
