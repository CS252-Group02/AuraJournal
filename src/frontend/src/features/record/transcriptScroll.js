// One frame loop and one pending destination; updates never restart the current tween.
export function createTranscriptScroll({ request = globalThis.requestAnimationFrame, cancel = globalThis.cancelAnimationFrame, duration = 220 } = {}) {
  let frame = null, element, destination, startTime, origin, target;
  function stop() {
    if (frame !== null) cancel(frame);
    frame = null; element = null; startTime = null;
  }
  function tick(time) {
    if (!element) return;
    startTime ??= time;
    const progress = Math.min(1, (time - startTime) / duration);
    const bottom = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTop = Math.min(bottom, origin + (target - origin) * (1 - (1 - progress) ** 3));
    if (progress === 1) {
      if (Math.abs(element.scrollTop - Math.min(destination, bottom)) <= 1) { stop(); return; }
      origin = element.scrollTop; target = Math.min(destination, bottom); startTime = time;
    }
    frame = request(tick);
  }
  return {
    follow(el, immediate = false) {
      const bottom = Math.max(0, el.scrollHeight - el.clientHeight);
      if (immediate) { stop(); el.scrollTop = bottom; return; }
      destination = bottom;
      if (frame !== null && element === el) return;
      stop();
      if (Math.abs(el.scrollTop - bottom) <= 1) return;
      element = el; origin = el.scrollTop; target = bottom;
      frame = request(tick);
    },
    cancel: stop,
  };
}
