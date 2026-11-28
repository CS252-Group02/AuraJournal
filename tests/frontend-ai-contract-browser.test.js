import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';
import { launchBrowser } from './helpers/browser.js';

// Synthetic HTTP failures only. The actual app/API client runs in Chromium;
// no real account, journal, microphone or external provider is accessed.
function installFixture() {
  const original = window.fetch;
  const today = new Date(), day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const id = '11111111-1111-4111-8111-111111111111';
  const entry = { id, content: 'Hôm nay tôi đọc sách. Tomorrow I plan a walk.', journal_date: day,
    created_at: `${day}T10:00:00Z`, updated_at: `${day}T10:00:00Z`, ai_summary: 'Previous valid entry note.' };
  const fixture = window.__aiFixture = { mode: 'missing', calls: [], id };
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (url, options = {}) => {
    const path = new URL(url, location.origin).pathname;
    if (!path.startsWith('/api/')) return original(url, options);
    fixture.calls.push({ path, method: options.method || 'GET' });
    if (path === '/api/auth/me') return json({ id: 'synthetic-a10-account', email: 'a10@example.test' });
    if (path === '/api/entries') return json([entry]);
    if (path.startsWith('/api/weekly-reflections/')) return json({ period_start: day, period_end: day,
      summary: 'Previous valid weekly reflection.', questions: ['What did you read?', 'What stood out?'], source_dates: null });
    if (fixture.mode === 'network') throw new TypeError('PRIVATE-provider-prompt');
    if (fixture.mode === 'proxy') return new Response('<html>PRIVATE-provider-prompt</html>', { status: 503 });
    if (fixture.mode === 'expired') return new Response('<html>PRIVATE-session</html>', { status: 401 });
    const status = { missing: 503, quota: 429, invalid: 502, oversized: 413 }[fixture.mode];
    return json({ detail: 'PRIVATE-provider-prompt' }, status);
  };
}

const binary = process.env.BROWSER_BIN || ['/usr/bin/chromium', '/usr/bin/google-chrome', '/opt/brave.com/brave/brave'].find(existsSync);
test('A10 UI recovers safely from AI and malformed HTTP failures', { skip: !binary && 'Set BROWSER_BIN', timeout: 180000 }, async context => {
  const server = await createServer({ root: resolve('src/frontend'), configFile: resolve('src/frontend/vite.config.js'),
    logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
  await server.listen(); context.after(() => server.close());
  const browser = await launchBrowser(binary); context.after(() => browser.close());
  await browser.call('Page.addScriptToEvaluateOnNewDocument', { source: `(${installFixture.toString()})()` });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const navigate = async (path, selector) => {
    await browser.call('Page.navigate', { url: origin + path });
    await browser.waitFor(`document.querySelector(${JSON.stringify(selector)})`);
  };
  const button = text => `Array.from(document.querySelectorAll('button')).find(node => node.textContent.trim() === ${JSON.stringify(text)})`;
  const click = async text => { await browser.waitFor(button(text)); await browser.evaluate(`${button(text)}.click()`); };

  await context.test('summary errors resolve loading, preserve the note and allow explicit retry', async () => {
    await navigate('/journal/11111111-1111-4111-8111-111111111111', '.entry-note-summary');
    for (const mode of ['missing', 'quota', 'invalid', 'proxy', 'network']) {
      const count = await browser.evaluate('window.__aiFixture.calls.length');
      await browser.evaluate(`window.__aiFixture.mode = ${JSON.stringify(mode)}`);
      await click('Regenerate reflection');
      await browser.waitFor("document.querySelector('.entry-note [role=alert]') && !document.querySelector('.entry-note button').disabled");
      assert.equal(await browser.evaluate("document.querySelector('.entry-note-summary').textContent"), 'Previous valid entry note.');
      assert.doesNotMatch(await browser.evaluate('document.body.innerText'), /PRIVATE|Unexpected token|SyntaxError/);
      assert.equal(await browser.evaluate(`window.__aiFixture.calls.slice(${count}).filter(call => call.method === 'POST').length`), 1);
    }
  });

  await context.test('recap and saved reflection recover without replacing saved content', async () => {
    await navigate('/reflection', '.saved-reflection-summary');
    for (const mode of ['missing', 'quota', 'invalid', 'proxy', 'network']) {
      await browser.evaluate(`window.__aiFixture.mode = ${JSON.stringify(mode)}`);
      await click('Regenerate');
      await browser.waitFor("document.querySelector('.saved-reflection-error') && !document.querySelector('.saved-reflection-foot button').disabled");
      assert.equal(await browser.evaluate("document.querySelector('.saved-reflection-summary').textContent"), 'Previous valid weekly reflection.');
      await click(mode === 'missing' ? 'Generate weekly recap' : 'Try again');
      await browser.waitFor("Array.from(document.querySelectorAll('button')).some(node => node.textContent === 'Try again' && !node.disabled)");
      assert.doesNotMatch(await browser.evaluate('document.body.innerText'), /PRIVATE|Unexpected token|SyntaxError/);
    }
  });

  await context.test('oversized saved reflection keeps the prior result and links to the week', async () => {
    await browser.evaluate("window.__aiFixture.mode = 'oversized'");
    await click('Regenerate');
    await browser.waitFor("document.querySelector('.saved-reflection-error')?.textContent.includes('too much text')");
    assert.equal(await browser.evaluate("document.querySelector('.saved-reflection-summary').textContent"), 'Previous valid weekly reflection.');
    assert.match(await browser.evaluate("document.querySelector('.saved-reflection-foot a.aj-btn').getAttribute('href')"), /history\?start=.+&end=.+/);
    assert.equal(await browser.evaluate("document.querySelector('.saved-reflection-foot button') === null"), true);
  });

  await context.test('non-JSON session expiry clears private UI and returns to login', async () => {
    await browser.evaluate("window.__aiFixture.mode = 'expired'");
    await click('Try again');
    await browser.waitFor("location.pathname === '/login' && document.querySelector('input[type=password]')");
    assert.doesNotMatch(await browser.evaluate('document.body.innerText'), /Previous valid|PRIVATE/);
  });
});
