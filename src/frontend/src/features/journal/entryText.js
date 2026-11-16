const TITLE_MAX = 60;
const WORDS_PER_MINUTE = 200;

function clip(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, '')}…`;
}

export function entryTitle(content = '') {
  const text = content.trim();
  if (!text) return 'Untitled entry';
  const firstLine = text.split(/\n/)[0].trim();
  const sentence = firstLine.match(/^.+?[.!?…](?=\s|$)/)?.[0] ?? firstLine;
  return clip(sentence.replace(/[.]+$/, ''), TITLE_MAX);
}

export function entryPreview(content = '') {
  const text = content.trim();
  const firstLine = text.split(/\n/)[0].trim();
  const sentence = firstLine.match(/^.+?[.!?…](?=\s|$)/)?.[0] ?? firstLine;
  const rest = text.slice(text.indexOf(sentence) + sentence.length).trim().replace(/\s+/g, ' ');
  if (rest) return rest;
  return entryTitle(content).endsWith('…') ? text.replace(/\s+/g, ' ') : '';
}

export function wordCount(content = '') {
  return content.trim().split(/\s+/).filter(Boolean).length;
}

export function readMinutes(content = '') {
  return Math.max(1, Math.round(wordCount(content) / WORDS_PER_MINUTE));
}

export const TONES = ['rose', 'butter', 'lavender', 'sky', 'sage'];
export function entryTone(id = '') {
  let hash = 0;
  for (const char of String(id)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return TONES[hash % TONES.length];
}

export function matchesSearch(entry, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [entry.content, entry.ai_summary, entry.ai_reflection_question]
    .some((value) => value?.toLowerCase().includes(needle));
}
