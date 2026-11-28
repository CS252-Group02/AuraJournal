import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { navigationMode, shouldGuardLink } from '../src/frontend/src/components/layout/navigation.js';

const origin = new URL('https://journal.example/record');
const click = (changes = {}) => ({ button: 0, defaultPrevented: false, ...changes });
const anchor = (href, target = '', download = false) => ({ href, target, hasAttribute: name => name === 'download' && download });

test('floating record visibility is limited to the content routes including the dedicated memories gallery', () => {
  for (const path of ['/dashboard', '/history', '/memories', '/reflection', '/journal/entry-id', '/dashboard/']) {
    assert.equal(navigationMode(path).floatingRecord, true, path);
    assert.equal(navigationMode(path).record, false, path);
  }
  for (const path of ['/', '/record', '/record/', '/login', '/register', '/missing', '/journal']) {
    assert.equal(navigationMode(path).floatingRecord, false, path);
  }
  assert.equal(navigationMode('/record/').record, true);
});

test('same-tab navigation is guarded without intercepting new tabs, downloads, external links, or content skips', () => {
  assert.equal(shouldGuardLink(click(), anchor('/history'), origin), true);
  assert.equal(shouldGuardLink(click(), anchor('/record?different=1'), origin), true);
  for (const event of [click({ ctrlKey: true }), click({ metaKey: true }), click({ shiftKey: true }),
    click({ altKey: true }), click({ button: 1 }), click({ defaultPrevented: true })]) {
    assert.equal(shouldGuardLink(event, anchor('/history'), origin), false);
  }
  for (const link of [null, anchor('/record#app-content'), anchor('/record'), anchor('https://other.example/'),
    anchor('/history', '_blank'), anchor('/history', '', true)]) {
    assert.equal(shouldGuardLink(click(), link, origin), false);
  }
});

async function loadComponents() {
  const result = await build({
    stdin: { contents: 'export {default as Shell} from "./AppShell.jsx"; export {default as Sidebar} from "./Sidebar.jsx"; export {default as Floating} from "./FloatingRecordButton.jsx";',
      resolveDir: fileURLToPath(new URL('../src/frontend/src/components/layout/', import.meta.url)), loader: 'jsx' },
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic',
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  return module.exports;
}
const components = loadComponents();
const render = (Component, props = {}, path = '/') => renderToStaticMarkup(React.createElement(MemoryRouter,
  { initialEntries: [path] }, React.createElement(Component, props)));

test('desktop sidebar starts collapsed with working links, accessible names, and an explicit pin control', async () => {
  const { Sidebar } = await components;
  const html = render(Sidebar);
  assert.match(html, /data-expanded="false"/);
  assert.match(html, /aria-label="Main navigation"/);
  for (const [label, path] of [['Main', '/'], ['Dashboard', '/dashboard'], ['History', '/history'], ['Moments in Pixels', '/memories'], ['Weekly recap', '/reflection'], ['Reflection Chat', '/reflection-chat']]) {
    assert.match(html, new RegExp(`aria-label="${label}"`));
    assert.ok(html.includes(`href="${path}"`));
  }
  assert.match(html, /aria-label="Keep navigation expanded" aria-pressed="false"/);
  assert.doesNotMatch(html, /soon|aria-disabled="true"|tabindex="-1"/);
});

test('sidebar highlights exactly one route, including History for a journal detail', async () => {
  const { Sidebar } = await components;
  for (const [path, label] of [['/', 'Main'], ['/dashboard', 'Dashboard'], ['/history', 'History'],
    ['/memories', 'Moments in Pixels'], ['/journal/id', 'History'], ['/reflection', 'Weekly recap'], ['/reflection-chat/abc', 'Reflection Chat']]) {
    const html = render(Sidebar, {}, path);
    assert.equal((html.match(/aria-current="page"/g) || []).length, 1, path);
    const active = html.match(/<a[^>]*aria-current="page"[^>]*>/)?.[0];
    assert.ok(active?.includes(`aria-label="${label}"`), active);
  }
});

test('drawer has readable labels and a keyboard-accessible close control', async () => {
  const { Sidebar } = await components;
  const html = render(Sidebar, { drawer: true });
  assert.match(html, /data-expanded="true"/);
  assert.match(html, /aria-label="Close navigation"/);
  assert.doesNotMatch(html, /Keep navigation expanded/);
});

test('floating control is one navigation link, with no recording or microphone setup', async () => {
  const { Floating } = await components;
  const html = render(Floating);
  assert.match(html, /aria-label="Start a voice journal"/);
  assert.match(html, /href="\/record"/);
  assert.equal((html.match(/<a /g) || []).length, 1);
  assert.doesNotMatch(html, /<button|<audio|<textarea/);
});

test('layout routes render one floating control where needed, fullscreen Record, and shell-free auth pages', async () => {
  const { Shell } = await components;
  for (const path of ['/', '/dashboard', '/history', '/journal/id', '/memories', '/reflection', '/record', '/login', '/register']) {
    const routes = React.createElement(Routes, {},
      React.createElement(Route, { element: React.createElement(Shell) },
        ...['/', '/dashboard', '/history', '/journal/:id', '/memories', '/reflection', '/record'].map(route => React.createElement(Route,
          { key: route, path: route, element: React.createElement('main', {}, `Content ${path}`) }))),
      ...['/login', '/register'].map(route => React.createElement(Route,
        { key: route, path: route, element: React.createElement('main', {}, 'Authentication') })));
    const html = renderToStaticMarkup(React.createElement(MemoryRouter, { initialEntries: [path] }, routes));
    assert.equal((html.match(/class="floating-record"/g) || []).length, navigationMode(path).floatingRecord ? 1 : 0, path);
    if (['/login', '/register'].includes(path)) {
      assert.doesNotMatch(html, /app-shell|Main navigation/);
    } else {
      assert.match(html, /Skip to content/);
      assert.ok(html.includes(`Content ${path}`));
      if (path === '/record') {
        assert.match(html, /app-shell-record/);
        assert.match(html, /<dialog[^>]*aria-label="Journal navigation"/);
        assert.doesNotMatch(html, /<aside class="app-sidebar"/);
        assert.doesNotMatch(html, /<dialog[^>]* open/);
      }
    }
  }
});
