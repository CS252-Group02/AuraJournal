import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { launchBrowser } from './helpers/browser.js';

// Only fixture journals and canvas PNGs. No backend or AI provider is contacted.
function installFixture() {
  const originalFetch = window.fetch;
  const today = new Date();
  const key = value => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  const day = offset => { const value = new Date(today); value.setDate(value.getDate() - offset); return key(value); };
  const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const row = (n, offset = 0) => ({ id: uuid(n), content: `Fictional moment ${n}. A quiet walk through the trees.`, journal_date: day(offset),
    created_at: `${day(offset)}T08:00:00Z`, updated_at: `${day(offset)}T08:00:00Z`, ai_summary: null });
  const first = [row(1), row(2), row(3), row(4, 1), row(5, 2), row(6, 3), row(7, 4), row(8, 5)];
  const second = [row(20)];
  const fixture = window.__memories = { identity: Math.random(), today: day(0), yesterday: day(1), first, phase: 'pending', requests: [],
    created: [], revoked: [], failImages: false };
  const createURL = URL.createObjectURL.bind(URL), revokeURL = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = blob => { const url = createURL(blob); fixture.created.push(url); return url; };
  URL.revokeObjectURL = url => { fixture.revoked.push(url); revokeURL(url); };
  const json = (value, status = 200) => Response.json(value, { status });
  const signedIn = () => !localStorage.getItem('fixture-logged-out');
  const identity = () => localStorage.getItem('fixture-account') === 'second' ? 'second' : 'first';
  const rows = () => identity() === 'second' ? second : first;
  window.fetch = async (url, options = {}) => {
    const parsed = new URL(url, location.origin), path = parsed.pathname, method = options.method || 'GET';
    if (!path.startsWith('/api/')) return originalFetch(url, options);
    fixture.requests.push({ path, method, credentials: options.credentials, cache: options.cache });
    if (path === '/api/auth/me') return signedIn() ? json({ id: uuid(identity() === 'second' ? 920 : 900), email: `${identity()}@example.com` }) : json({}, 401);
    if (path === '/api/auth/logout') { localStorage.setItem('fixture-logged-out', '1'); return json({}); }
    if (path === '/api/auth/login') {
      localStorage.removeItem('fixture-logged-out'); localStorage.setItem('fixture-account', 'second');
      return json({ id: uuid(920), email: 'second@example.com' });
    }
    if (!signedIn()) return json({}, 401);
    if (path === '/api/entries' && method === 'GET') return json(rows());
    if (path === '/api/entries/pixel-art/memories') {
      const asOf = parsed.searchParams.get('as_of'), groups = new Map();
      for (const entry of rows().filter(row => row.journal_date <= asOf)) {
        const n = Number(entry.id.slice(-12));
        const status = n === 4 ? fixture.phase : ({ 5: 'unavailable', 6: 'uncertain', 7: 'not_requested', 8: 'failed' }[n] || 'ready');
        if (!groups.has(entry.journal_date)) groups.set(entry.journal_date, []);
        groups.get(entry.journal_date).push({ entry_id: entry.id,
          generation: { status, error_code: null, updated_at: `${entry.journal_date}T10:00:00Z` },
          image: status === 'ready' ? { id: uuid(n + 100), file_format: 'png', width: 128, height: 128,
            created_at: `${entry.journal_date}T${String(8 + (n % 4)).padStart(2, '0')}:00:00Z`,
            content_url: `/api/entries/${entry.id}/pixel-art/content` } : null });
      }
      return json({ as_of: asOf, days: [...groups].sort(([a], [b]) => b.localeCompare(a)).slice(0, 7)
        .map(([journal_date, entries]) => ({ journal_date, entries })) });
    }
    if (path.endsWith('/pixel-art/content')) {
      if (fixture.failImages) return json({}, 503);
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
      const context = canvas.getContext('2d');
      context.fillStyle = '#dce8d7'; context.fillRect(0, 0, 128, 128);
      context.fillStyle = '#6a946e'; context.fillRect(0, 84, 128, 44);
      context.fillStyle = '#3d654c'; context.fillRect(18, 24, 12, 68); context.fillRect(2, 16, 44, 36);
      context.fillStyle = '#ebe3cc'; context.fillRect(64, 40, 12, 12); context.fillRect(60, 52, 20, 28);
      context.fillStyle = '#8d735b'; context.fillRect(60, 80, 8, 20); context.fillRect(72, 80, 8, 20);
      return new Response(Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), c => c.charCodeAt(0)),
        { headers: { 'Content-Type': 'image/png' } });
    }
    if (path.includes('/pixel-art') && method === 'POST') throw new Error('Gallery attempted AI generation');
    if (path.startsWith('/api/weekly-reflections/')) return json({}, 404);
    return json({}, 404);
  };
}

const browserBinary = process.env.BROWSER_BIN || ['/usr/bin/chromium', '/usr/bin/google-chrome', '/opt/brave.com/brave/brave'].find(existsSync);

test('dedicated pixel gallery stays private, read-only and responsive in a browser', {
  skip: !browserBinary && 'Set BROWSER_BIN to a Chromium executable', timeout: 180000,
}, async context => {
  const server = await createServer({ root: resolve('src/frontend'), configFile: resolve('src/frontend/vite.config.js'),
    logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  await server.listen(); context.after(() => server.close());
  const browser = await launchBrowser(browserBinary); context.after(() => browser.close());
  await browser.call('Page.addScriptToEvaluateOnNewDocument', { source: `(${installFixture.toString()})()` });
  const evaluate = browser.evaluate, origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const navigate = async (path, selector) => {
    await browser.call('Page.navigate', { url: origin + path });
    await browser.waitFor(`location.pathname === ${JSON.stringify(path)} && document.querySelector(${JSON.stringify(selector)})`);
  };
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await mkdir('/tmp/aurajournal-pr2-gallery', { recursive: true });
  await browser.call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await navigate('/memories', '.pixel-memories-page');
  await browser.waitFor("document.querySelector('.pixel-memory-art img')?.complete && document.querySelectorAll('.pixel-memory-day').length === 7");

  await context.test('route, active navigation and record destination use the shared shell', async () => {
    assert.equal(await evaluate("document.querySelectorAll('.account-trigger').length"), 1);
    assert.equal(await evaluate("document.querySelector('.sidebar-link[aria-current=page]').getAttribute('href')"), '/memories');
    assert.equal(await evaluate("document.querySelector('.floating-record').getAttribute('href')"), '/record');
    assert.equal(await evaluate("document.querySelectorAll('.pixel-memory-day').length"), 7);
    assert.equal(await evaluate("document.querySelectorAll('.pixel-generate-button').length"), 0);
    assert.ok(!await evaluate("Array.from(document.querySelectorAll('button')).some(button=>/Generate|Retry generation/.test(button.textContent))"));
  });

  await context.test('carousel controls are below art and keep the source journal synchronized', async () => {
    const today = await evaluate('__memories.today');
    const card = `.pixel-memory-day[data-memory-date="${today}"]`;
    const first = await evaluate(`document.querySelector(${JSON.stringify(card + ' .pixel-memory-caption')}).getAttribute('href')`);
    await click(card + ' button[aria-label^="Next artwork"]');
    assert.notEqual(await evaluate(`document.querySelector(${JSON.stringify(card + ' .pixel-memory-caption')}).getAttribute('href')`), first);
    assert.equal(await evaluate(`(() => {const c=document.querySelector(${JSON.stringify(card)});return c.querySelector('.pixel-memory-caption').href===c.querySelector('a.pixel-memory-art').href})()`), true);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(card + ' .pixel-memory-carousel span[id]')}).textContent`), '2 / 3');
    await evaluate(`document.querySelector(${JSON.stringify(card + ' button[aria-label^="Next artwork"]')}).focus()`);
    await browser.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(card + ' .pixel-memory-carousel span[id]')}).textContent`), '1 / 3');
  });

  await context.test('unchanged polling preserves Blob URLs and ready updates appear automatically', async () => {
    const today = await evaluate('__memories.today');
    const selector = `.pixel-memory-day[data-memory-date="${today}"] img`;
    const url = await evaluate(`document.querySelector(${JSON.stringify(selector)}).src`);
    const requests = await evaluate("__memories.requests.filter(r=>r.path==='/api/entries/pixel-art/memories').length");
    await browser.waitFor(`__memories.requests.filter(r=>r.path==='/api/entries/pixel-art/memories').length>${requests}`);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).src`), url);
    await evaluate("__memories.phase='ready'");
    await browser.waitFor("document.querySelector('.pixel-memory-day[data-memory-date=\"'+__memories.yesterday+'\"] img')?.complete");
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).src`), url);
    const unsafe = await evaluate("__memories.requests.filter(r=>r.path.includes('/pixel-art')&&r.method!=='GET')");
    assert.deepEqual(unsafe, []);
    assert.ok(await evaluate("__memories.requests.filter(r=>r.path.endsWith('/pixel-art/content')).every(r=>r.credentials==='include'&&r.cache==='no-store')"));
  });

  await context.test('all requested widths and both themes contain the scroller and leave artwork unobstructed', async () => {
    for (const width of [320, 768, 1024, 1440]) {
      await browser.call('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: false });
      await browser.waitFor("document.querySelector(" + JSON.stringify(width < 768 ? '.shell-mobile-toggle' : '.app-sidebar:not(.is-drawer)') + ")");
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      for (const theme of ['light', 'dark']) {
        if (await evaluate('document.documentElement.dataset.theme') !== theme) {
          await click('.account-trigger'); await browser.waitFor("document.querySelector('.account-panel')");
          await evaluate(`Array.from(document.querySelectorAll('.account-panel button')).find(button=>button.textContent===${JSON.stringify(theme === 'light' ? 'Light' : 'Dark')}).click()`);
          await browser.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
          await browser.waitFor("!document.querySelector('.account-panel')");
        }
        const expectedColor = theme === 'light' ? 'rgb(36, 52, 46)' : 'rgb(240, 238, 228)';
        const expectedBackground = theme === 'light' ? 'rgb(247, 246, 241)' : 'rgb(28, 40, 35)';
        await browser.waitFor(`getComputedStyle(document.querySelector('.pixel-memory-caption')).color===${JSON.stringify(expectedColor)} && getComputedStyle(document.querySelector('.pixel-memories-page')).backgroundColor===${JSON.stringify(expectedBackground)}`);
        const geometry = await evaluate(`(() => {
          function lum(value){return value.match(/[0-9.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0)}
          const cards=[...document.querySelectorAll('.pixel-memory-day')], scroller=document.querySelector('.pixel-memory-days');
          return { body:document.documentElement.scrollWidth, viewport:innerWidth, scroll:scroller.scrollWidth, client:scroller.clientWidth,
            contrast:[...document.querySelectorAll('.pixel-memory-caption')].map(caption=>{const c=getComputedStyle(caption).color,b=getComputedStyle(document.querySelector('.pixel-memories-page')).backgroundColor;
              return {c,b,ratio:(Math.max(lum(c),lum(b))+.05)/(Math.min(lum(c),lum(b))+.05)}}),
            cards:cards.map(card=>{const art=card.querySelector('.pixel-memory-art'), image=card.querySelector('img'), controls=card.querySelector('.pixel-memory-carousel');
              const a=art.getBoundingClientRect(),c=controls?.getBoundingClientRect();return {square:Math.abs(a.width-a.height),width:a.width,
                clean:!c||c.top>=a.bottom+8, buttonFits:!c||c.left>=a.left-1&&c.right<=a.right+1,
                image:image&&{width:image.getBoundingClientRect().width,height:image.getBoundingClientRect().height,
                  rendering:getComputedStyle(image).imageRendering,fit:getComputedStyle(image).objectFit,filter:getComputedStyle(image).filter}}})};
        })()`);
        assert.ok(geometry.contrast.every(item=>item.ratio>=4.5), `${width}/${theme}: caption contrast ${JSON.stringify(geometry.contrast)}`);
        assert.ok(geometry.body <= geometry.viewport, `${width}/${theme}: page overflow ${geometry.body}/${geometry.viewport}`);
        assert.ok(geometry.cards.every(card => card.square < 2 && card.width >= 160 && card.clean && card.buttonFits));
        for (const card of geometry.cards.filter(card => card.image)) {
          assert.ok(card.image.width >= 160); assert.ok(Math.abs(card.image.width - card.image.height) < 2);
          assert.equal(card.image.rendering, 'pixelated'); assert.equal(card.image.fit, 'contain'); assert.equal(card.image.filter, 'none');
        }
        if (width < 1440) assert.ok(geometry.scroll > geometry.client);
        if (width === 1440) assert.ok(geometry.scroll <= geometry.client + 1);
        await browser.screenshot(`/tmp/aurajournal-pr2-gallery/${width}-${theme}.png`);
      }
    }
  });

  await context.test('image read errors offer only PNG retry and preserve the correct journal destination', async () => {
    await evaluate('__memories.failImages=true');
    const today = await evaluate('__memories.today'), card = `.pixel-memory-day[data-memory-date="${today}"]`;
    await click(card + ' button[aria-label^="Next artwork"]');
    await browser.waitFor(`document.querySelector(${JSON.stringify(card + ' .pixel-memory-failure button')})`);
    const destination = await evaluate(`document.querySelector(${JSON.stringify(card + ' .pixel-memory-art')}).href`);
    await evaluate('__memories.failImages=false'); await click(card + ' .pixel-memory-failure button');
    await browser.waitFor(`document.querySelector(${JSON.stringify(card + ' img')})?.complete`);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(card + ' .pixel-memory-art')}).href`), destination);
    assert.deepEqual(await evaluate("__memories.requests.filter(r=>r.path.includes('/pixel-art')&&r.method==='POST')"), []);
  });

  await context.test('Dashboard keeps activity and links to the gallery without embedding a copy', async () => {
    await navigate('/dashboard', '.calendar');
    assert.equal(await evaluate("document.querySelectorAll('.pixel-memory-day').length"), 0);
    assert.ok(await evaluate("Boolean(document.querySelector('.dashboard-links a[href=\"/memories\"]'))"));
    assert.ok(await evaluate("document.body.textContent.includes('Current streak') && document.body.textContent.includes('Moods')"));
  });

  await context.test('written saves and content edits disclose external artwork processing before submission', async () => {
    await navigate('/', '.home-page'); await click('.home-write-link');
    assert.ok(await evaluate(`(() => {const note=document.querySelector('#home-art-disclosure'),save=document.querySelector('.home-writing button[type=submit],.home-writing-footer button');
      return note&&/Groq.*PixelLab/.test(note.textContent)&&Boolean(note.compareDocumentPosition(save)&Node.DOCUMENT_POSITION_FOLLOWING)})()`));
    await navigate('/journal/00000000-0000-4000-8000-000000000001', '.entry-paper');
    await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Edit').click()");
    assert.ok(await evaluate(`(() => {const note=document.querySelector('#entry-art-disclosure'),save=document.querySelector('.entry-edit button[type=submit]');
      return note&&/symbolic or inaccurate/.test(note.textContent)&&Boolean(note.compareDocumentPosition(save)&Node.DOCUMENT_POSITION_FOLLOWING)})()`));
    assert.equal(await evaluate("document.querySelectorAll('input[type=checkbox]').length"), 0);
  });

  await context.test('logout revokes private URLs and protected gallery cannot show the previous account', async () => {
    await navigate('/memories', '.pixel-memories-page');
    await browser.waitFor("document.querySelector('.pixel-memory-art img')?.complete");
    const created = await evaluate('__memories.created.length');
    await click('.account-trigger');
    await evaluate("Array.from(document.querySelectorAll('.account-panel button')).find(b=>b.textContent==='Log out').click()");
    await browser.waitFor("location.pathname==='/login'");
    assert.ok(await evaluate(`__memories.revoked.length>=${created}`));
    assert.equal(await evaluate("document.querySelectorAll('.pixel-memory-art').length"), 0);
    const oldIdentity = await evaluate('__memories.identity');
    await browser.call('Page.navigate', { url: origin + '/memories' });
    await browser.waitFor(`window.__memories?.identity!==${oldIdentity} && location.pathname==='/login' && document.querySelector('input[type=email]')`);
    await evaluate("document.querySelector('input[type=email]').focus()");
    await browser.call('Input.insertText', { text: 'second@example.com' });
    await evaluate("document.querySelector('input[type=password]').focus()");
    await browser.call('Input.insertText', { text: 'test-password-long' });
    await click('button[type=submit]'); await browser.waitFor("location.pathname==='/' && document.querySelector('.sidebar-link[href=\"/memories\"]')");
    await click('.sidebar-link[href="/memories"]');
    await browser.waitFor("document.querySelector('.pixel-memory-art img')?.complete");
    assert.ok(await evaluate("document.querySelector('.pixel-memory-caption').getAttribute('href').endsWith('000000000020')"));
    assert.ok(!await evaluate("document.querySelector('.pixel-memories').textContent.includes('Fictional moment 1.')"));
  });
});
