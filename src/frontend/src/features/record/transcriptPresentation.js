// Presentation identities only: joining these runs must reproduce the input exactly.
export function reconcileTokens(previous, text) {
  const runs = text.match(/\s+|\S+/gu) || [];
  const old = previous?.tokens || [];
  let prefix = 0, suffix = 0, nextKey = previous?.nextKey || 0;
  while (prefix < old.length && prefix < runs.length && old[prefix].text === runs[prefix]) prefix++;
  while (suffix < old.length - prefix && suffix < runs.length - prefix &&
      old[old.length - suffix - 1].text === runs[runs.length - suffix - 1]) suffix++;
  const changes = [];
  const tokens = runs.map((run, index) => {
    if (index < prefix) return old[index];
    if (index >= runs.length - suffix) return old[old.length - runs.length + index];
    const token = { key: nextKey++, text: run, word: /\S/u.test(run) };
    if (token.word) changes.push({ key: token.key, kind: prefix === old.length ? 'reveal' : 'correction' });
    return token;
  });
  return { tokens, changes, nextKey };
}

// A partial final can move an already-visible suffix into a new segment ID.
// This suppresses motion only; it never changes provider text or segment identity.
export function carriesInterim(previous, finals, interim) {
  if (!previous || !interim || previous.segment_id === interim.segment_id) return false;
  const final = finals.find(segment => segment.segment_id === previous.segment_id);
  if (!final || !interim.text.trim()) return false;
  const before = previous.text.trimEnd(), suffix = interim.text.trimEnd();
  const start = before.length - suffix.length;
  return start > 0 && before.endsWith(suffix) && /\s/u.test(before[start - 1]);
}

export function createWordAnimations() {
  const active = new Map();
  function remove(key) {
    const animation = active.get(key);
    active.delete(key);
    animation?.cancel();
  }
  return {
    reveal(key, node, kind) {
      remove(key);
      if (!node?.animate) return;
      const frames = kind === 'reveal'
        ? [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translateY(0)' }]
        : [{ opacity: 0.55 }, { opacity: 1 }];
      const animation = node.animate(frames, { duration: kind === 'reveal' ? 160 : 120, easing: 'ease-out' });
      active.set(key, animation);
      animation.onfinish = animation.oncancel = () => {
        if (active.get(key) === animation) active.delete(key);
      };
    },
    retain(keys) { for (const key of active.keys()) if (!keys.has(key)) remove(key); },
    cancel() { for (const key of active.keys()) remove(key); },
  };
}
