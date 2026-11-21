import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { launchBrowser } from './helpers/browser.js';

// Explicit opt-in: BROWSER_BIN=/path/to/chromium npm run test:frontend:browser
// Uses only local API fixtures; it never logs into or mutates a real account.
function installFixture() {
  const originalFetch = window.fetch;
  const today = new Date();
  const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const id = '11111111-1111-4111-8111-111111111111';
  const entry = { id, content: 'A quiet walk. I enjoyed the trees and a warm cup of tea.',
    journal_date: day, created_at: `${day}T10:00:00Z`, updated_at: `${day}T10:00:00Z`, ai_summary: 'A peaceful moment outdoors.' };
  const fixture = window.__fixture = { identity: Math.random(), requests: [], holdSave: false, releaseSave: null, failLogout: false };
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (url, options = {}) => {
    const path = new URL(url, location.origin).pathname, method = options.method || 'GET';
    if (!path.startsWith('/api/')) return originalFetch(url, options);
    fixture.requests.push({ path, method });
    if (path === '/api/auth/me') return localStorage.getItem('test-logged-out')
      ? json({ detail: 'Not authenticated' }, 401) : json({ id: 'browser-user', email: 'journal@example.test' });
    if (path === '/api/auth/logout') {
      await new Promise(resolve => setTimeout(resolve, 100));
      if (fixture.failLogout) return json({ detail: 'Connection failed' }, 503);
      localStorage.setItem('test-logged-out', '1'); return json({});
    }
    if (path === '/api/auth/login' || path === '/api/auth/register') {
      localStorage.removeItem('test-logged-out'); return json({ id: 'browser-user', email: 'journal@example.test' });
    }
    if (path === '/api/entries/pixel-art/recent') return json([{ entry_id: id, journal_date: day,
      image: { id: '22222222-2222-4222-8222-222222222222', width: 128, height: 128,
        file_format: 'png', created_at: `${day}T10:01:00Z`, content_url: `/api/entries/${id}/pixel-art/content` } }]);
    if (path.endsWith('/pixel-art/content')) {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
      const context = canvas.getContext('2d'); context.fillStyle = '#a2c6ab'; context.fillRect(0, 0, 128, 128);
      context.fillStyle = '#4f7c65'; context.fillRect(32, 32, 64, 64);
      const bytes = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), value => value.charCodeAt(0));
      return new Response(bytes, { headers: { 'Content-Type': 'image/png' } });
    }
    if (path === '/api/entries' && method === 'GET') return json([entry]);
    if ((path === '/api/entries' && method === 'POST') || (path === `/api/entries/${id}` && method === 'PATCH')) {
      if (fixture.holdSave) await new Promise(resolve => { fixture.releaseSave = resolve; });
      return json({ ...entry, ...JSON.parse(options.body) });
    }
    if (path === '/api/transcriptions') return json({ outcome: 'transcribed', transcript: 'A recorded journal for review.' });
    if (path.startsWith('/api/weekly-reflections/')) return json({ detail: 'No saved reflection' }, 404);
    return json({ detail: 'Fixture endpoint not configured' }, 404);
  };
}

const browserBinary = process.env.BROWSER_BIN || ['/usr/bin/chromium', '/usr/bin/google-chrome', '/opt/brave.com/brave/brave'].find(existsSync);

test('account menu, appearance, and existing guards work in a real browser', {
  skip: !browserBinary && 'Set BROWSER_BIN to a Chromium executable', timeout: 180000,
}, async context => {
  const server = await createServer({ root: resolve('src/frontend'), configFile: resolve('src/frontend/vite.config.js'),
    logLevel: 'error', define: {
      'import.meta.env.VITE_RECORD_TRANSCRIPTION_PATH': '""',
      'import.meta.env.VITE_RECORD_PROOFREAD_PATH': '""',
      'import.meta.env.VITE_RECORD_IDEMPOTENT_SAVE': '"false"',
    }, server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  context.after(() => server.close());
  const browser = await launchBrowser(browserBinary);
  context.after(() => browser.close());
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  await browser.call('Page.addScriptToEvaluateOnNewDocument', { source: `(${installFixture.toString()})()` });
  let acceptDialogs = false;
  const dialogs = [], errors = [];
  browser.on('Runtime.exceptionThrown', event => errors.push(event.exceptionDetails.exception?.description || event.exceptionDetails.text));
  browser.on('Page.javascriptDialogOpening', event => {
    dialogs.push(event);
    browser.call('Page.handleJavaScriptDialog', { accept: event.type === 'beforeunload' || acceptDialogs });
  });
  const evaluate = browser.evaluate;
  const click = async selector => {
    await browser.waitFor(`document.querySelector(${JSON.stringify(selector)})`);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  };
  const textButton = text => `Array.from(document.querySelectorAll('button')).find(node => node.textContent.trim() === ${JSON.stringify(text)})`;
  const clickText = async text => { await browser.waitFor(textButton(text)); await evaluate(`${textButton(text)}.click()`); };
  const openMenu = async () => { await click('.account-trigger'); await browser.waitFor("document.querySelector('.account-panel')"); };
  const navigate = async (path, ready) => {
    const navigation = await browser.call('Page.navigate', { url: origin + path });
    if (navigation.errorText) throw new Error(`Navigation failed: ${navigation.errorText}`);
    await browser.waitFor(`location.pathname === ${JSON.stringify(path)} && document.querySelector(${JSON.stringify(ready)})`);
  };
  const key = async (value, modifiers = 0) => {
    const codes = { Enter: 13, Escape: 27, Tab: 9, ' ': 32 };
    const text = value === 'Enter' ? '\r' : value === ' ' ? ' ' : '';
    const code = value === ' ' ? 'Space' : value;
    await browser.call('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: value, code,
      text, unmodifiedText: text, windowsVirtualKeyCode: codes[value], modifiers });
    await browser.call('Input.dispatchKeyEvent', { type: 'keyUp', key: value, code, windowsVirtualKeyCode: codes[value], modifiers });
  };
  const reload = async ready => {
    const identity = await evaluate('__fixture.identity');
    await browser.call('Page.reload');
    await browser.waitFor(`window.__fixture?.identity !== ${identity} && document.querySelector(${JSON.stringify(ready)})`);
  };
  const fill = async (selector, value) => {
    await evaluate(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    input.focus(); input.select();
  })()`);
    await browser.call('Input.insertText', { text: value });
  };
  const logoutCalls = () => evaluate("__fixture.requests.filter(r => r.path === '/api/auth/logout').length");
  const theme = () => evaluate('document.documentElement.dataset.theme');
  const screenshots = '/tmp/aurajournal-account-checks';
  await mkdir(screenshots, { recursive: true });
  await browser.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  // Fail at startup if the app cannot mount, so later checks have a valid page.
  try { await navigate('/', '.home-page'); }
  catch (error) { throw new Error(`${error.message}; runtime errors: ${JSON.stringify(errors)}`); }

  await context.test('all five target pages share email, safe Settings, and the same account controls', async () => {
    for (const [path, ready] of [['/', '.home-page'], ['/dashboard', '.calendar'], ['/history', '.history-grid'],
      ['/journal/11111111-1111-4111-8111-111111111111', '.entry-paper'], ['/reflection', '.reflection-page']]) {
      await navigate(path, ready);
      assert.equal(await theme(), 'light');
      assert.equal(await evaluate("document.querySelectorAll('.account-trigger').length"), 1);
      await openMenu();
      assert.equal(await evaluate("document.querySelector('.account-info p').textContent"), 'journal@example.test');
      assert.equal(await evaluate("document.querySelector('.account-navigation button').disabled"), true);
      assert.match(await evaluate("document.querySelector('.account-navigation').textContent"), /Settings.*Coming soon/);
      assert.equal(await evaluate("document.querySelector('.account-navigation a')"), null);
      assert.equal(await evaluate("document.querySelector('.appearance-toggle button[aria-pressed=true]').textContent"), 'Light');
      assert.ok(await evaluate("document.querySelector('.account-session button').textContent === 'Log out'"));
      await key('Escape');
      assert.equal(await evaluate("document.activeElement.className"), 'account-trigger');
      assert.equal(await evaluate("document.querySelector('.account-panel')"), null);
      const name = path === '/' ? 'main' : path.startsWith('/journal/') ? 'entry' : path.slice(1);
      await browser.screenshot(`${screenshots}/${name}-light.png`);
    }
  });

  await context.test('keyboard activation, Tab boundaries, Escape, focus exit, and outside click', async () => {
    await evaluate("document.querySelector('.account-trigger').focus()");
    await key('Enter');
    await browser.waitFor("document.activeElement.textContent === 'Light'");
    await key('Tab');
    assert.equal(await evaluate('document.activeElement.textContent'), 'Dark');
    await key(' ');
    assert.equal(await theme(), 'dark');
    assert.ok(await evaluate("!!document.querySelector('.account-panel')"));
    await key('Tab'); await key('Tab');
    assert.equal(await evaluate('document.activeElement.className'), 'account-trigger');
    await key(' '); await key('Tab', 8);
    assert.equal(await evaluate("document.querySelector('.account-panel')"), null);
    await openMenu();
    await browser.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: 400, y: 400, button: 'left', clickCount: 1 });
    await browser.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 400, y: 400, button: 'left', clickCount: 1 });
    assert.equal(await evaluate("document.querySelector('.account-panel')"), null);
    await openMenu();
    await evaluate("document.querySelector('.aj-breadcrumb a').focus()");
    assert.equal(await evaluate("document.querySelector('.account-panel')"), null);
  });

  await context.test('theme survives reload/navigation, keeps session state, and never filters pixel art', async () => {
    await navigate('/', '.home-page');
    await openMenu(); await clickText('Dark'); await key('Escape');
    assert.equal(await theme(), 'dark');
    await click('.home-nav a[href="/dashboard"]');
    await browser.waitFor("document.querySelector('.pixel-memory-art img')?.complete");
    assert.equal(await theme(), 'dark');
    assert.equal(await logoutCalls(), 0);
    assert.equal(await evaluate("document.querySelector('.account-trigger').title"), 'journal@example.test');
    const image = await evaluate(`(() => {
      const image = document.querySelector('.pixel-memory-art img');
      return {rendering:getComputedStyle(image).imageRendering, filters:[image, ...function*(){let n=image.parentElement;while(n){yield n;n=n.parentElement}}()].map(n=>getComputedStyle(n).filter)};
    })()`);
    assert.equal(image.rendering, 'pixelated');
    assert.ok(image.filters.every(filter => filter === 'none'));
    await openMenu(); await clickText('Light');
    assert.equal(await theme(), 'light');
    assert.ok(await evaluate("!!document.querySelector('.account-panel')"));
    await clickText('Dark'); await key('Escape');
    await reload('.calendar');
    assert.equal(await theme(), 'dark');
    assert.equal(await evaluate("localStorage.getItem('aurajournal-theme')"), 'dark');
  });

  await context.test('dark surfaces, text, data cells, focus, stacking, and mobile placement remain readable', async () => {
    await navigate('/dashboard', '.calendar');
    const contrast = await evaluate(`(() => {
      function rgb(s){return s.match(/[\\d.]+/g).slice(0,3).map(Number)}
      function luminance(c){return rgb(c).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0)}
      function ratio(a,b){const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)}
      const page=getComputedStyle(document.querySelector('.dashboard-page'));
      const cell=getComputedStyle(document.querySelector('.calendar-day'));
      const surface=getComputedStyle(document.querySelector('.calendar'));
      const muted=getComputedStyle(document.querySelector('.calendar-navigation p'));
      const button=getComputedStyle(document.querySelector('.dashboard-links button'));
      return {text:ratio(page.color,page.backgroundColor),muted:ratio(muted.color,surface.backgroundColor),data:ratio(cell.color,cell.backgroundColor),button:ratio(button.color,surface.backgroundColor)};
    })()`);
    for (const [name, ratio] of Object.entries(contrast)) assert.ok(ratio >= 4.5, `${name}: ${ratio}`);
    await openMenu();
    assert.ok(await evaluate(`(() => {const panel=document.querySelector('.account-panel'),r=panel.getBoundingClientRect();return document.elementFromPoint(r.x+10,r.y+10)===panel})()`));
    assert.equal(await evaluate("getComputedStyle(document.activeElement).outlineStyle"), 'solid');
    await browser.screenshot(`${screenshots}/dashboard-dark-menu.png`);
    await key('Escape');
    for (const [name, path, ready] of [['main', '/', '.home-page'], ['history', '/history', '.history-grid'],
      ['entry', '/journal/11111111-1111-4111-8111-111111111111', '.entry-paper'], ['reflection', '/reflection', '.reflection-page'],
      ['record', '/record', '.record-page']]) {
      await navigate(path, ready);
      await browser.screenshot(`${screenshots}/${name}-dark.png`);
      if (name === 'record') assert.equal(await evaluate("document.querySelector('.account-trigger')"), null);
    }
    await navigate('/dashboard', '.calendar');
    await browser.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await openMenu();
    assert.ok(await evaluate(`(() => {const r=document.querySelector('.account-panel').getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.bottom<=innerHeight})()`));
    await browser.screenshot(`${screenshots}/dashboard-dark-mobile.png`);
    await key('Escape');
    await click('.shell-mobile-toggle');
    await browser.waitFor("document.querySelector('dialog[open]')");
    await browser.screenshot(`${screenshots}/sidebar-dark-mobile.png`);
    await key('Escape');
    await browser.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  });

  await context.test('Record keeps its fullscreen design, active-take confirmations, and save-time navigation block', async () => {
    acceptDialogs = false;
    await navigate('/record', '.record-page');
    await click('.record-trigger');
    await browser.waitFor("document.querySelector('.record-page').dataset.recordPhase === 'recording'");
    const start = dialogs.length;
    await click('.record-back');
    assert.equal(dialogs.length, start + 1);
    assert.equal(await evaluate("document.querySelector('.record-page').dataset.recordPhase"), 'recording');
    assert.equal(await evaluate("document.querySelector('.account-trigger')"), null);
    await click('.record-sidebar-toggle');
    await click('.is-drawer a[href="/history"]');
    assert.equal(dialogs.length, start + 2);
    assert.equal(await evaluate('location.pathname'), '/record');
    await key('Escape');
    await evaluate('new Promise(resolve => setTimeout(resolve, 400))');
    await click('.record-trigger'); await browser.waitFor("document.querySelector('.record-page').dataset.recordPhase === 'review'");
    await fill('#record-draft', 'A take to keep');
    await evaluate('__fixture.holdSave = true'); await click('.record-save');
    await browser.waitFor('__fixture.releaseSave');
    assert.equal(await evaluate("document.querySelector('.record-back').getAttribute('aria-disabled')"), 'true');
    await click('.record-sidebar-toggle'); await click('.is-drawer a[href="/history"]');
    assert.equal(dialogs.length, start + 2);
    assert.equal(await evaluate('location.pathname'), '/record');
    await key('Escape'); await evaluate('__fixture.releaseSave()');
    await browser.waitFor("document.querySelector('.record-page').dataset.recordPhase === 'saved'");
    await click('.record-back'); await browser.waitFor("document.querySelector('.home-page')");
  });

  await context.test('Main logout and links confirm once, respect cancellation, and block during save', async () => {
    await navigate('/', '.home-page'); await click('.home-write-link'); await fill('#home-entry', 'An unsaved journal draft');
    const start = dialogs.length;
    await openMenu(); await clickText('Log out');
    assert.equal(dialogs.length, start + 1);
    assert.equal(await logoutCalls(), 0);
    assert.equal(await evaluate("document.querySelector('#home-entry').value"), 'An unsaved journal draft');
    await key('Escape'); await click('.home-nav a[href="/history"]');
    assert.equal(dialogs.length, start + 2);
    assert.equal(await evaluate('location.pathname'), '/');
    await evaluate('__fixture.holdSave = true'); await click('.home-writing button[type="submit"], .home-writing-footer button');
    await browser.waitFor('__fixture.releaseSave');
    await openMenu(); await clickText('Log out');
    assert.equal(dialogs.length, start + 2);
    assert.equal(await logoutCalls(), 0);
    await evaluate('__fixture.releaseSave()');
    await browser.waitFor("!document.querySelector('#home-entry')");
    await key('Escape'); await click('.home-write-link'); await fill('#home-entry', 'Approved discard');
    await openMenu(); acceptDialogs = true;
    await clickText('Log out');
    await browser.waitFor("location.pathname === '/login' && document.querySelector('.login')");
    assert.equal(dialogs.length, start + 3);
    assert.equal(await logoutCalls(), 1);
    assert.equal(await theme(), 'dark');
    acceptDialogs = false;
    await browser.screenshot(`${screenshots}/login-dark.png`);
  });

  await context.test('auth routes share appearance; login retains it and Entry logout uses its own guard', async () => {
    acceptDialogs = false;
    await clickText('Light'); assert.equal(await theme(), 'light');
    await click('.login-switch a');
    await browser.waitFor("location.pathname === '/register'");
    assert.equal(await theme(), 'light');
    await clickText('Dark');
    await browser.screenshot(`${screenshots}/register-dark.png`);
    await click('.login-switch a'); await fill('#email', 'journal@example.test'); await fill('#password', 'a password for fixtures');
    await click('.login-button'); await browser.waitFor("document.querySelector('.home-page')");
    assert.equal(await theme(), 'dark');
    await navigate('/journal/11111111-1111-4111-8111-111111111111', '.entry-paper');
    await clickText('Edit'); await fill('#entry-draft', 'Unsaved edited journal');
    const start = dialogs.length;
    await openMenu(); await clickText('Log out');
    assert.equal(dialogs.length, start + 1);
    assert.equal(await logoutCalls(), 0);
    assert.equal(await evaluate("document.querySelector('#entry-draft').value"), 'Unsaved edited journal');
    await key('Escape'); await evaluate('__fixture.holdSave = true'); await clickText('Save changes');
    await browser.waitFor('__fixture.releaseSave');
    await openMenu(); await clickText('Log out');
    assert.equal(dialogs.length, start + 1); assert.equal(await logoutCalls(), 0);
    await evaluate('__fixture.releaseSave()'); await browser.waitFor("!document.querySelector('#entry-draft')");
    await key('Escape'); await clickText('Edit'); await fill('#entry-draft', 'Another unsaved change');
    await openMenu(); acceptDialogs = true; await clickText('Log out');
    await browser.waitFor("location.pathname === '/login'");
    assert.equal(dialogs.length, start + 2); assert.equal(await logoutCalls(), 1);
    acceptDialogs = false;
  });

  await context.test('duplicate logout is prevented and server failures keep existing retry handling', async () => {
    await evaluate("localStorage.removeItem('test-logged-out')");
    await navigate('/', '.home-page'); await openMenu();
    await evaluate("__fixture.failLogout = true;const button=document.querySelector('.account-session button');button.click();button.click()");
    await browser.waitFor("document.querySelector('.page[role=status]')?.textContent === 'Logging out…'");
    await browser.waitFor("document.querySelector('.page[role=alert]')");
    assert.equal(await logoutCalls(), 1);
    assert.match(await evaluate('document.body.innerText'), /Logout could not be confirmed/);
    assert.equal(await theme(), 'dark');
    await evaluate('__fixture.failLogout = false'); await clickText('Retry logout');
    await browser.waitFor("location.pathname === '/login'");
    assert.equal(await logoutCalls(), 2);
  });

  await context.test('invalid/missing/blocked storage and cross-tab preference changes are safe', async () => {
    await evaluate("localStorage.removeItem('test-logged-out');localStorage.setItem('aurajournal-theme','invalid')");
    await navigate('/', '.home-page'); assert.equal(await theme(), 'light');
    await evaluate("localStorage.removeItem('aurajournal-theme')");
    await reload('.home-page');
    assert.equal(await theme(), 'light');
    await evaluate("localStorage.setItem('aurajournal-theme','dark');dispatchEvent(new StorageEvent('storage',{key:'aurajournal-theme',newValue:'dark'}))");
    await browser.waitFor("document.documentElement.dataset.theme === 'dark'");
    const { identifier } = await browser.call('Page.addScriptToEvaluateOnNewDocument', {
      source: "Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Blocked','SecurityError')}})",
    });
    await reload('.page[role=alert]');
    // The API fixture also uses localStorage, so auth reaches its existing error screen.
    await browser.waitFor("document.querySelector('.page[role=alert]')");
    assert.equal(await theme(), 'light');
    await browser.call('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    await navigate('/', '.home-page'); await openMenu();
    await evaluate("Storage.prototype.setItem = () => {throw new DOMException('Full','QuotaExceededError')}");
    await clickText('Light'); assert.equal(await theme(), 'light');
    await clickText('Dark'); assert.equal(await theme(), 'dark');
    await key('Escape');
  });
  assert.deepEqual(errors, []);
});
