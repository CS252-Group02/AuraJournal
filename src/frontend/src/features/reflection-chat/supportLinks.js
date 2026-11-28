export function safeSupportUrl(value) {
  if (typeof value !== 'string' || /[\s\x00-\x1f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname && !url.username && !url.password) return url.href;
    if (url.protocol === 'tel:' && /^tel:\+?[0-9()-]+$/.test(value)) return value;
  } catch { /* Ignore malformed resource metadata. */ }
  return null;
}
