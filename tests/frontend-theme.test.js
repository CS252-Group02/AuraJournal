import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { applyTheme, normalizeTheme, persistTheme, readTheme, THEME_KEY } from '../src/frontend/src/theme/theme.js';
import { ACCOUNT_NAVIGATION } from '../src/frontend/src/components/layout/accountNavigation.js';

function browserGlobals(context, storage) {
  for (const [key, value] of Object.entries({ window: { localStorage: storage }, document: { documentElement: { dataset: {} } } })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    context.after(() => previous ? Object.defineProperty(globalThis, key, previous) : delete globalThis[key]);
  }
}

test('appearance accepts exactly Light and Dark, defaulting safely to Light', () => {
  for (const value of [undefined, null, '', 'system', 'Dark', 'invalid', '{}', {}, 1]) {
    assert.equal(normalizeTheme(value), 'light');
  }
  assert.equal(normalizeTheme('light'), 'light');
  assert.equal(normalizeTheme('dark'), 'dark');
});

test('theme persistence reads/writes the existing key without modifying other storage', context => {
  const data = new Map([['session', 'private']]);
  browserGlobals(context, { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) });
  assert.equal(readTheme(), 'light');
  persistTheme('dark');
  assert.equal(data.get(THEME_KEY), 'dark');
  assert.equal(readTheme(), 'dark');
  applyTheme(readTheme());
  assert.equal(document.documentElement.dataset.theme, 'dark');
  persistTheme('light');
  applyTheme(readTheme());
  assert.equal(document.documentElement.dataset.theme, 'light');
  assert.equal(data.get('session'), 'private');
  data.set(THEME_KEY, '{broken json');
  assert.equal(readTheme(), 'light');
});

test('blocked storage reads and writes cannot prevent a session appearance change', context => {
  browserGlobals(context, {
    getItem() { throw new DOMException('Blocked', 'SecurityError'); },
    setItem() { throw new DOMException('Quota full', 'QuotaExceededError'); },
  });
  assert.equal(readTheme(), 'light');
  assert.doesNotThrow(() => persistTheme('dark'));
  applyTheme('dark');
  assert.equal(document.documentElement.dataset.theme, 'dark');
});

test('a browser denying access to localStorage itself falls back safely', context => {
  browserGlobals(context, null);
  Object.defineProperty(window, 'localStorage', { get() { throw new Error('Denied'); } });
  assert.equal(readTheme(), 'light');
  assert.doesNotThrow(() => persistTheme('light'));
});

test('startup applies saved appearance before React and uses the same fallback rules', async () => {
  const html = await readFile(new URL('../src/frontend/index.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  for (const value of [null, 'dark', 'light', 'system', 'invalid', '{}']) {
    const document = { documentElement: { dataset: { theme: 'light' } } };
    vm.runInNewContext(script, { document, localStorage: { getItem: key => {
      assert.equal(key, THEME_KEY); return value;
    } } });
    assert.equal(document.documentElement.dataset.theme, normalizeTheme(value));
  }
  const document = { documentElement: { dataset: {} } };
  vm.runInNewContext(script, { document, localStorage: { getItem() { throw new Error('Unavailable'); } } });
  assert.equal(document.documentElement.dataset.theme, 'light');
  assert.ok(html.indexOf('<script>') < html.indexOf('/src/main.jsx'));
});

test('Settings links to the shipped /settings route', () => {
  assert.deepEqual(ACCOUNT_NAVIGATION.find(item => item.id === 'settings'), {
    id: 'settings', label: 'Settings', to: '/settings', available: true,
  });
});
