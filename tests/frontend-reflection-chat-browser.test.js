import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'vite';
import { launchBrowser } from './helpers/browser.js';

const fixtures = JSON.parse(readFileSync(new URL('../docs/fixtures/reflection-chat.json', import.meta.url)));
function installFixture(f) {
  const original = window.fetch, chats = new Map(); let sequence = 0;
  const control = window.__chat = { calls: [], outcome: 'reflection', fail: 0, hold: false, release: null, conflict: false, supportFail: false };
  control.savedFor = message => [...chats.values()].flatMap(chat => chat.turns).filter(turn => turn.message === message).length;
  const json = (data, status = 200, headers = {}) => new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  window.fetch = async (url, options = {}) => {
    const parsed = new URL(url, location.origin), path = parsed.pathname, method = options.method || 'GET', body = options.body ? JSON.parse(options.body) : null;
    if (!path.startsWith('/api/')) return original(url, options);
    control.calls.push({ path, method, body });
    if (path === '/api/auth/me') return json({ id: 'chat-user', email: 'chat@example.test' });
    if (path === '/api/auth/login') { chats.clear(); return json({ id: 'other-user', email: 'other@example.test' }); }
    if (path === '/api/entries') return json([]);
    if (path === '/api/auth/logout') return json({}, 204);
    if (path === '/api/reflection-chats/support') return control.supportFail ? json({}, 503) : json({ ...f.support, country: parsed.searchParams.get('country') });
    if (path === '/api/reflection-chats' && method === 'GET') {
      if (parsed.searchParams.has('cursor')) {
        const id = '00000000-0000-4000-8000-000000000999';
        chats.set(id, { chat: { ...f.chat, id, title: 'Archived chat', revision: 2 },
          turns: [{ ...f.turn_responses.reflection, turn_id: 'archive-latest', message: 'Latest archive message', revision: 2 }], next_before_revision: 2 });
        return json({ chats: [chats.get(id).chat], next_cursor: null });
      }
      return json({ chats: [...chats.values()].filter(item => item.chat.title !== 'Archived chat').map(item => item.chat), next_cursor: 'older' });
    }
    if (path === '/api/reflection-chats' && method === 'POST') {
      const id = `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
      chats.set(id, { chat: { ...f.chat, id }, turns: [], next_before_revision: null }); return json(chats.get(id).chat, 201);
    }
    const match = path.match(/^\/api\/reflection-chats\/([^/]+)(\/turns)?$/);
    if (!match) return json({ detail: 'Not configured' }, 404);
    const id = match[1], detail = chats.get(id);
    if (!detail) return json({ detail: 'Reflection chat not found.' }, 404);
    if (method === 'GET' && parsed.searchParams.has('before_revision')) return json({ ...detail, turns: [{ ...f.turn_responses.reflection, turn_id: 'archive-earliest', message: 'Earlier archive message', revision: 1 }], next_before_revision: null });
    if (method === 'GET') return json(control.clearSources ? { ...detail, turns: detail.turns.map(turn => ({ ...turn, sources: [] })) } : detail);
    if (method === 'DELETE') { chats.delete(id); return json(null, 204); }
    if (method === 'PATCH') {
      if (control.accessConflict) { control.accessConflict = false; detail.chat.journal_access_version++; return json({ detail: 'Journal access changed.' }, 409); }
      detail.chat = { ...detail.chat, use_journals: body.use_journals, journal_access_version: detail.chat.journal_access_version + 1 };
      return json(detail.chat);
    }
    if (match[2] && method === 'POST') {
      if (control.hold) await new Promise(resolve => { control.release = resolve; });
      if (control.fail) { const status = control.fail; control.fail = 0; return json({ detail: 'Try again' }, status, { 'Retry-After': '1' }); }
      if (control.conflict) { control.conflict = false; detail.chat.revision++; return json({ detail: 'Conversation changed.' }, 409); }
      const existing = detail.turns.find(turn => turn.turn_id === body.turn_id); if (existing) return json(existing);
      const turn = { ...f.turn_responses[control.outcome], turn_id: body.turn_id, message: body.message, revision: ++detail.chat.revision };
      detail.turns.push(turn); detail.chat.title = body.message.slice(0, 60); return json(turn);
    }
    return json({}, 400);
  };
}
const binary = process.env.BROWSER_BIN || ['/usr/bin/chromium', '/usr/bin/brave-browser'].find(existsSync);
test('Reflection Chat browser acceptance with fictional local fixtures', { skip: !binary }, async context => {
  const server = await createServer({ configFile: 'src/frontend/vite.config.js', root: 'src/frontend', server: { host: '127.0.0.1', port: 0 } });
  await server.listen(); context.after(() => server.close());
  const browser = await launchBrowser(binary); context.after(() => browser.close());
  const errors = []; browser.on('Runtime.exceptionThrown', event => errors.push(event.exceptionDetails.text));
  await browser.call('Page.addScriptToEvaluateOnNewDocument', { source: `(${installFixture.toString()})(${JSON.stringify(fixtures)})` });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const evaluate = browser.evaluate;
  async function click(selector) { await browser.waitFor(`document.querySelector(${JSON.stringify(selector)})`); await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); }
  async function button(text, scope = 'document') {
    const expression = `Array.from(${scope}.querySelectorAll('button')).find(el => el.textContent.trim() === ${JSON.stringify(text)})`;
    await browser.waitFor(expression); await evaluate(`${expression}.click()`);
  }
  async function draft(value) {
    await browser.waitFor("document.querySelector('textarea#chat-draft:not(:disabled)')");
    await evaluate(`{ const el = document.querySelector('#chat-draft'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input',{bubbles:true})); }`);
  }
  async function waitReply(text) { await browser.waitFor(`document.querySelector('.chat-messages').innerText.includes(${JSON.stringify(text)})`); }
  await browser.call('Page.navigate', { url: origin + '/reflection-chat' });
  await browser.waitFor("document.querySelector('.chat-empty')");
  await click('.account-trigger'); await browser.waitFor("document.querySelector('.account-panel')");
  assert.equal(await evaluate("document.querySelector('.account-panel').innerText.includes('chat@example.test')"), true);
  await browser.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await context.test('saved history and older-message pagination resume conversations', async () => {
    await button('Load more chats', "document.querySelector('.chat-history')");
    await click('.chat-history a[href$="000000000999"]'); await waitReply('Latest archive message');
    await button('Load older messages'); await waitReply('Earlier archive message');
    assert.equal(await evaluate("document.querySelector('.chat-messages').innerText.indexOf('Earlier archive message') < document.querySelector('.chat-messages').innerText.indexOf('Latest archive message')"), true);
    await click('a[aria-label="Reflection Chat"]'); await browser.waitFor("document.querySelector('.chat-empty')");
  });
  await button('Start a new chat'); await browser.waitFor("document.querySelector('#chat-draft')");
  const firstUrl = await evaluate('location.pathname');

  await context.test('composer sends English/Vietnamese and displays all five outcomes as text', async () => {
    await evaluate("document.querySelector('[aria-label=\"Reply language\"]').value='vi';document.querySelector('[aria-label=\"Reply language\"]').dispatchEvent(new Event('change',{bubbles:true}))");
    for (const outcome of ['reflection', 'mood_boundary', 'out_of_scope', 'professional_support', 'urgent_support']) {
      await evaluate(`__chat.outcome=${JSON.stringify(outcome)}`);
      await draft(`Experience ${outcome}`); await button('Send'); await waitReply(fixtures.turn_responses[outcome].reply);
    }
    assert.equal(await evaluate("__chat.calls.filter(c=>c.path.endsWith('/turns')).at(-1).body.locale"), 'vi');
    await evaluate("__chat.outcome='reflection'"); await draft('<img src=x onerror=alert(1)>'); await button('Send');
    await waitReply('<img src=x onerror=alert(1)>'); assert.equal(await evaluate("document.querySelectorAll('.chat-messages img').length"), 0);
  });
  await context.test('support options require explicit country and keep guidance after failure', async () => {
    assert.equal(await evaluate("__chat.calls.filter(c=>c.path.includes('/support')).length"), 0);
    await evaluate("{const el=document.querySelectorAll('[aria-label=\"Support country code\"]').item(1);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'VN');el.dispatchEvent(new Event('input',{bubbles:true}));__chat.supportFail=true;}");
    await button('Find support options', "document.querySelectorAll('.chat-support').item(1)"); await browser.waitFor("document.querySelectorAll('.chat-support').item(1).querySelector('[role=alert]')");
    await evaluate('__chat.supportFail=false'); await button('Find support options', "document.querySelectorAll('.chat-support').item(1)");
    await browser.waitFor("document.querySelector('.chat-support a')");
    assert.equal(await evaluate("document.querySelector('.chat-support a').getAttribute('rel')"), 'noopener noreferrer');
  });
  await context.test('failed retries preserve IDs, prevent duplicates and handle conflicts and cooldowns', async () => {
    await evaluate('__chat.fail=503'); await draft('Retry my reflection'); await button('Send');
    await browser.waitFor("document.querySelector('[role=alert]')"); await button('Retry message'); await waitReply('Retry my reflection');
    assert.equal(await evaluate("{const calls=__chat.calls.filter(c=>c.path.endsWith('/turns'));calls.at(-1).body.turn_id===calls.at(-2).body.turn_id}"), true);
    await evaluate('__chat.conflict=true'); await draft('Concurrent reflection'); await button('Send');
    await browser.waitFor("document.body.innerText.includes('Review the latest messages')");
    assert.equal(await evaluate("document.querySelector('#chat-draft').value"), 'Concurrent reflection');
    await button('Retry message'); await waitReply('Concurrent reflection');
    await evaluate('__chat.fail=429'); await draft('Cooldown'); await button('Send');
    await browser.waitFor("document.querySelector('.chat-composer').innerText.includes('Try again in')");
    assert.equal(await evaluate("document.querySelector('.chat-composer button').disabled"), true);
    assert.equal(await evaluate("document.querySelector('#chat-draft').value"), 'Cooldown');
    assert.equal(await evaluate("__chat.savedFor('Cooldown')"), 0);
    await browser.waitFor("!document.querySelector('.chat-composer button').disabled"); await button('Retry message'); await waitReply('Cooldown');
    assert.equal(await evaluate("__chat.savedFor('Cooldown')"), 1);
    const cooldownCalls = await evaluate("__chat.calls.filter(call=>call.body?.message==='Cooldown').map(call=>call.body.turn_id)");
    assert.equal(cooldownCalls.length, 2);
    assert.equal(cooldownCalls[0], cooldownCalls[1]);
  });
  await context.test('switching chats discards pending results and preserves in-memory drafts', async () => {
    await evaluate('__chat.hold=true'); await draft('Pending in first chat'); await button('Send');
    await browser.waitFor('__chat.release');
    await button('New chat', "document.querySelector('.chat-history')");
    await browser.waitFor(`location.pathname !== ${JSON.stringify(firstUrl)} && document.querySelector('#chat-draft')`);
    await evaluate('__chat.hold=false;__chat.release()');
    await browser.waitFor("document.querySelector('.chat-messages')");
    assert.equal(await evaluate("document.querySelector('.chat-messages').innerText.includes('Pending in first chat')"), false);
    await draft('Draft in second chat');
    await click(`.chat-history a[href="${firstUrl}"]`); await browser.waitFor("document.querySelector('#chat-draft')?.value==='' && document.querySelector('.chat-messages')?.innerText.includes('Pending in first chat')");
  });
  await context.test('journal consent, citations, missing evidence and opt-out during generation', async () => {
    const toggle = '.chat-journal-access input';
    assert.equal(await evaluate(`document.querySelector('${toggle}').checked`), false);
    await click(toggle); await browser.waitFor(`document.querySelector('${toggle}').checked && !document.querySelector('${toggle}').disabled`);
    await evaluate("__chat.outcome='grounded_reflection'"); await draft('Find my harbor walk'); await button('Send');
    await browser.waitFor("document.querySelector('.chat-sources a')");
    assert.equal(await evaluate("document.querySelector('.chat-sources a').getAttribute('href')"), '/journal/3514c39a-4637-40e5-b332-4b4b423fa82c');
    assert.equal(await evaluate("document.querySelector('.chat-sources a').textContent"), 'Nov 27, 2026');
    await evaluate('__chat.accessConflict=true'); await click(toggle);
    await browser.waitFor("document.body.innerText.includes('changed in another tab')");
    assert.equal(await evaluate(`document.querySelector('${toggle}').checked`), true);
    await evaluate("__chat.hold=true; __chat.release=null"); await draft('Pending journal reflection'); await button('Send'); await browser.waitFor('__chat.release');
    await click(toggle); await browser.waitFor(`!document.querySelector('${toggle}').checked && !document.querySelector('${toggle}').disabled`);
    await evaluate('__chat.fail=409;__chat.hold=false;__chat.release()');
    assert.equal(await evaluate("document.querySelector('#chat-draft').value"), 'Pending journal reflection');
    // Clear citations in the server fixture to represent an edited/deleted source.
    await evaluate("__chat.clearSources=true");
    await button('New chat', "document.querySelector('.chat-history')");
    await browser.waitFor(`location.pathname !== ${JSON.stringify(firstUrl)} && document.querySelector('.chat-journal-access input')`);
    assert.equal(await evaluate(`document.querySelector('${toggle}').checked`), false);
    await click(`.chat-history a[href="${firstUrl}"]`);
    await browser.waitFor(`location.pathname === ${JSON.stringify(firstUrl)} && document.querySelector('#chat-draft')?.value === 'Pending journal reflection' && document.querySelectorAll('.chat-sources a').length === 0`);
    await evaluate("__chat.outcome='reflection';__chat.fail=0"); await draft('No matching journal evidence'); await button('Send'); await waitReply('No matching journal evidence');
    assert.equal(await evaluate("document.querySelectorAll('.chat-sources a').length"), 0);
  });
  await context.test('mobile history, keyboard composition, deletion focus, and themes', async () => {
    await browser.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await click('.chat-history-toggle'); await browser.waitFor("document.querySelector('.chat-history-dialog').open");
    await browser.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await browser.waitFor("!document.querySelector('.chat-history-dialog').open");
    assert.equal(await evaluate("document.activeElement===document.querySelector('.chat-history-toggle')"), true);
    await draft('IME text');
    const count = await evaluate("__chat.calls.filter(c=>c.path.endsWith('/turns')).length");
    await evaluate("document.querySelector('#chat-draft').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}))");
    assert.equal(await evaluate("__chat.calls.filter(c=>c.path.endsWith('/turns')).length"), count);
    await evaluate("document.querySelector('#chat-draft').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
    await waitReply('IME text');
    await evaluate("document.documentElement.dataset.theme='dark'");
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    await button('Delete chat'); await browser.waitFor("document.querySelector('.aj-dialog').open");
    await button('Cancel', "document.querySelector('.aj-dialog')");
    assert.equal(await evaluate("document.activeElement.textContent"), 'Delete chat');
    await button('Delete chat'); await button('Delete conversation'); await browser.waitFor("location.pathname==='/reflection-chat' && document.querySelector('.chat-empty')");
  });
  await context.test('session expiry discards pending replies and a new account has no inherited draft', async () => {
    await button('Start a new chat'); await browser.waitFor("document.querySelector('#chat-draft')");
    await evaluate("__chat.hold=true;__chat.release=null;__chat.outcome='reflection'");
    await draft('Private old account message'); await button('Send'); await browser.waitFor('__chat.release');
    await evaluate("dispatchEvent(new Event('aurajournal:unauthorized'))");
    await browser.waitFor("location.pathname==='/login'");
    await evaluate('__chat.hold=false;__chat.release()');
    assert.equal(await evaluate("document.body.innerText.includes('Private old account message')"), false);
    await evaluate("for (const [id,value] of [['email','other@example.test'],['password','fictional-password']]) { const el=document.getElementById(id);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true})); }");
    await button('Log in'); await browser.waitFor("location.pathname==='/'");
    // Use a same-document route change through the real React Router link.
    await evaluate("document.querySelector('a[href=\"/reflection-chat\"]').click()");
    await browser.waitFor("document.querySelector('.chat-empty')");
    await button('Start a new chat'); await browser.waitFor("document.querySelector('#chat-draft')");
    assert.equal(await evaluate("document.querySelector('#chat-draft').value"), '');
    assert.equal(await evaluate("document.body.innerText.includes('Private old account message')"), false);
  });
  assert.deepEqual(errors, []);
});
